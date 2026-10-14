-- Hand-written: reports (Phase 2, step 2.9). 0048 made daily_sales_summary and report_dirty_days.
--
-- The summary is a cache of facts that are already stored on the sale and refund rows: it adds
-- nothing a manager cannot already read, only faster. It is rebuilt per shop-local day by
-- ops.rebuild_summary_day (pg-boss job, no client access), so a number on a report is always a sum
-- of stored cents, never a recalculation. Refunds are dated by the refund's own time, as in the
-- Z-report. Reports read the summary through public.report_summary (managers and owners only, the
-- shop's RLS applies); the dashboard never scans sales.

-- ---------------------------------------------------------------- RLS
alter table public.daily_sales_summary enable row level security;
revoke all on public.daily_sales_summary from anon, authenticated;
grant select on public.daily_sales_summary to authenticated;
create policy daily_sales_summary_select on public.daily_sales_summary for select to authenticated
  using (org_id in (select app.manager_org_ids()));

alter table public.report_dirty_days enable row level security;
revoke all on public.report_dirty_days from anon, authenticated;
create policy report_dirty_days_deny_all on public.report_dirty_days as restrictive for all
  to anon, authenticated using (false) with check (false);

-- ---------------------------------------------------------------- mark a day dirty
-- A sale or refund can land days late (an offline till), so every insert marks its own shop-local
-- day. SECURITY DEFINER because clients cannot write the table.
create function app.mark_report_day() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_tz text;
begin
  -- A sale must never fail because a report mark could not be written: swallow the error here and
  -- let the nightly job (which re-marks the last 3 days) catch the day instead.
  begin
    select l.timezone into v_tz from public.locations l
     where l.org_id = new.org_id and l.id = new.location_id;
    insert into public.report_dirty_days (org_id, location_id, day)
    values (new.org_id, new.location_id, (new.completed_at at time zone coalesce(v_tz, 'Europe/Dublin'))::date)
    -- An update (not "do nothing") so the sale holds a lock on the mark until it commits: the
    -- rebuild skips a locked mark and picks the day up on its next round, and a rebuild that has
    -- already taken the mark makes the sale wait and then write a fresh one. No sale is missed.
    on conflict (org_id, location_id, day) do update set marked_at = now();
  exception when others then
    null;
  end;
  return new;
end
$$;
revoke all on function app.mark_report_day() from public, anon, authenticated;

create trigger sales_mark_report_day after insert on public.sales
  for each row execute function app.mark_report_day();
create trigger refunds_mark_report_day after insert on public.refunds
  for each row execute function app.mark_report_day();

-- Days that already hold sales or refunds get their first build from the nightly job.
insert into public.report_dirty_days (org_id, location_id, day)
select x.org_id, x.location_id, x.day
  from (
    select s.org_id, s.location_id, (s.completed_at at time zone l.timezone)::date as day
      from public.sales s join public.locations l on l.org_id = s.org_id and l.id = s.location_id
    union
    select r.org_id, r.location_id, (r.completed_at at time zone l.timezone)::date
      from public.refunds r join public.locations l on l.org_id = r.org_id and l.id = r.location_id
  ) x
on conflict do nothing;

-- ---------------------------------------------------------------- ops.rebuild_summary_day
-- Deletes and rebuilds every row of one shop-local day in one transaction, so a reader sees the old
-- day or the new one. Money columns are plain sums of stored cents:
--   total      : sales_count/gross = sales and their amount due (incl. rounding and deposits);
--                net/vat/discount = item lines; refund_gross = value returned: money paid back plus exchange credit
--                (refunds.amount_cents + credit_cents), because the replacement sale is in gross at full value
--   hour, staff: sale count, amount due, VAT, tips; refunds by their own time / cashier
--   tender     : payments (net of change) and tips; refund_payments for the refund side
--   vat_rate, category, product, brand, size_colour: item lines only (deposits are outside VAT and
--                reported on the total row), refund side from refund_lines at the ORIGINAL rate
create function ops.rebuild_summary_day(p_org uuid, p_location uuid, p_day date) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_tz text;
  v_from timestamptz;
  v_to timestamptz;
begin
  select l.timezone into v_tz from public.locations l where l.org_id = p_org and l.id = p_location;
  if not found then
    return;
  end if;
  v_from := p_day::timestamp at time zone v_tz;
  v_to := (p_day + 1)::timestamp at time zone v_tz;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text || p_location::text || p_day::text, 0));

  delete from public.daily_sales_summary
   where org_id = p_org and location_id = p_location and day = p_day;

  insert into public.daily_sales_summary (
    org_id, location_id, day, dim, key, label, sales_count, qty, gross_cents, net_cents, vat_cents,
    discount_cents, tips_cents, refund_count, refund_qty, refund_gross_cents, refund_net_cents,
    refund_vat_cents)
  with
  s as materialized (
    select * from public.sales
     where org_id = p_org and location_id = p_location and completed_at >= v_from and completed_at < v_to
  ),
  r as materialized (
    select * from public.refunds
     where org_id = p_org and location_id = p_location and completed_at >= v_from and completed_at < v_to
  ),
  pay as materialized (
    select p.* from public.payments p join s on s.id = p.sale_id where p.org_id = p_org
  ),
  rpay as materialized (
    select p.* from public.refund_payments p join r on r.id = p.refund_id where p.org_id = p_org
  ),
  sl as materialized (
    select l.sale_id, l.qty, coalesce(l.net_cents, 0) as net_cents, coalesce(l.vat_cents, 0) as vat_cents,
           l.gross_cents, l.discount_cents, l.tax_rate_bp, l.variant_id,
           p.id as product_id, p.name as product_name, p.category_id, c.name as category_name,
           nullif(btrim(v.attributes ->> 'brand'), '') as brand,
           case when nullif(btrim(v.attributes ->> 'size'), '') is not null
                then btrim(v.attributes ->> 'size') || ' / '
                     || coalesce(nullif(btrim(v.attributes ->> 'colour'), ''), '-') end as size_colour
      from public.sale_lines l
      join s on s.id = l.sale_id
      left join public.variants v on v.org_id = l.org_id and v.id = l.variant_id
      left join public.products p on p.org_id = l.org_id and p.id = coalesce(l.product_id, v.product_id)
      left join public.categories c on c.org_id = p.org_id and c.id = p.category_id
     where l.org_id = p_org and l.kind = 'item'
  ),
  rl as materialized (
    select l.refund_id, l.qty, coalesce(l.net_cents, 0) as net_cents, coalesce(l.vat_cents, 0) as vat_cents,
           l.gross_cents, l.tax_rate_bp,
           p.id as product_id, p.name as product_name, p.category_id, c.name as category_name,
           nullif(btrim(v.attributes ->> 'brand'), '') as brand,
           case when nullif(btrim(v.attributes ->> 'size'), '') is not null
                then btrim(v.attributes ->> 'size') || ' / '
                     || coalesce(nullif(btrim(v.attributes ->> 'colour'), ''), '-') end as size_colour
      from public.refund_lines l
      join r on r.id = l.refund_id
      left join public.variants v on v.org_id = l.org_id and v.id = l.variant_id
      left join public.products p on p.org_id = l.org_id and p.id = v.product_id
      left join public.categories c on c.org_id = p.org_id and c.id = p.category_id
     where l.org_id = p_org and l.kind = 'item'
  ),
  -- sales side: dim, key, label, count, qty, gross, net, vat, discount, tips
  sf as (
    select 'total'::text as dim, 'all'::text as key, 'All sales'::text as label,
           (select count(*) from s) as cnt,
           (select coalesce(sum(qty), 0) from sl) as qty,
           (select coalesce(sum(amount_due_cents), 0) from s) as gross,
           (select coalesce(sum(net_cents), 0) from sl) as net,
           (select coalesce(sum(vat_cents), 0) from s) as vat,
           -- A service-charge line has no variant: the cents on it are rounding, not a discount.
           (select coalesce(sum(discount_cents), 0) from sl where variant_id is not null) as disc,
           (select coalesce(sum(tip_cents), 0) from pay) as tips
     where exists (select 1 from s)
    union all
    select 'hour', lpad(extract(hour from completed_at at time zone v_tz)::int::text, 2, '0'),
           lpad(extract(hour from completed_at at time zone v_tz)::int::text, 2, '0') || ':00',
           count(*), 0, sum(amount_due_cents), 0, sum(vat_cents), 0, 0
      from s group by 2, 3
    union all
    select 'staff', cashier_user_id::text,
           coalesce((select m.display_name from public.memberships m
                      where m.org_id = p_org and m.user_id = s.cashier_user_id), 'Staff'),
           count(*), 0, sum(amount_due_cents), 0, sum(vat_cents), 0,
           coalesce(sum((select sum(p.tip_cents) from pay p where p.sale_id = s.id)), 0)
      from s group by cashier_user_id
    union all
    -- Exchange credit is one row whichever side names it (the sale says "Exchange", the refund "Exchange credit").
    select 'tender', method || '|' || case when method = 'exchange' then 'Exchange credit' else coalesce(label, initcap(method)) end,
           case when method = 'exchange' then 'Exchange credit' else coalesce(label, initcap(method)) end,
           count(*), 0, sum(amount_cents), 0, 0, 0, sum(tip_cents)
      from pay group by method, case when method = 'exchange' then 'Exchange credit' else coalesce(label, initcap(method)) end
    union all
    select 'vat_rate', tax_rate_bp::text,
           trim(trailing '.' from trim(trailing '0' from (tax_rate_bp / 100.0)::numeric(6, 2)::text)) || '%',
           count(distinct sale_id), sum(qty), sum(gross_cents), sum(net_cents), sum(vat_cents),
           sum(discount_cents), 0
      from sl where tax_rate_bp is not null group by tax_rate_bp
    union all
    select 'category', coalesce(category_id::text, 'none'), coalesce(max(category_name), 'No category'),
           count(distinct sale_id), sum(qty), sum(gross_cents), sum(net_cents), sum(vat_cents),
           sum(discount_cents), 0
      from sl group by category_id
    union all
    select 'product', coalesce(product_id::text, 'none'), coalesce(max(product_name), 'Other (no product)'),
           count(distinct sale_id), sum(qty), sum(gross_cents), sum(net_cents), sum(vat_cents),
           sum(discount_cents), 0
      from sl group by product_id
    union all
    select 'brand', brand, brand, count(distinct sale_id), sum(qty), sum(gross_cents), sum(net_cents),
           sum(vat_cents), sum(discount_cents), 0
      from sl where brand is not null group by brand
    union all
    select 'size_colour', size_colour, size_colour, count(distinct sale_id), sum(qty), sum(gross_cents),
           sum(net_cents), sum(vat_cents), sum(discount_cents), 0
      from sl where size_colour is not null group by size_colour
  ),
  -- refund side: dim, key, label, count, qty, gross, net, vat
  rf as (
    select 'total'::text as dim, 'all'::text as key, 'All sales'::text as label,
           (select count(*) from r) as cnt,
           (select coalesce(sum(qty), 0) from rl) as qty,
           (select coalesce(sum(amount_cents + credit_cents), 0) from r) as gross,
           (select coalesce(sum(net_cents), 0) from rl) as net,
           (select coalesce(sum(vat_cents), 0) from r) as vat
     where exists (select 1 from r)
    union all
    select 'hour', lpad(extract(hour from completed_at at time zone v_tz)::int::text, 2, '0'),
           lpad(extract(hour from completed_at at time zone v_tz)::int::text, 2, '0') || ':00',
           count(*), 0, sum(amount_cents + credit_cents), 0, sum(vat_cents)
      from r group by 2, 3
    union all
    select 'staff', cashier_user_id::text,
           coalesce((select m.display_name from public.memberships m
                      where m.org_id = p_org and m.user_id = r.cashier_user_id), 'Staff'),
           count(*), 0, sum(amount_cents + credit_cents), 0, sum(vat_cents)
      from r group by cashier_user_id
    union all
    select 'tender', method || '|' || case when method = 'exchange' then 'Exchange credit' else coalesce(label, initcap(method)) end,
           case when method = 'exchange' then 'Exchange credit' else coalesce(label, initcap(method)) end,
           count(*), 0, sum(amount_cents), 0, 0
      from rpay group by method, case when method = 'exchange' then 'Exchange credit' else coalesce(label, initcap(method)) end
    union all
    select 'vat_rate', tax_rate_bp::text,
           trim(trailing '.' from trim(trailing '0' from (tax_rate_bp / 100.0)::numeric(6, 2)::text)) || '%',
           count(distinct refund_id), sum(qty), sum(gross_cents), sum(net_cents), sum(vat_cents)
      from rl where tax_rate_bp is not null group by tax_rate_bp
    union all
    select 'category', coalesce(category_id::text, 'none'), coalesce(max(category_name), 'No category'),
           count(distinct refund_id), sum(qty), sum(gross_cents), sum(net_cents), sum(vat_cents)
      from rl group by category_id
    union all
    select 'product', coalesce(product_id::text, 'none'), coalesce(max(product_name), 'Other (no product)'),
           count(distinct refund_id), sum(qty), sum(gross_cents), sum(net_cents), sum(vat_cents)
      from rl group by product_id
    union all
    select 'brand', brand, brand, count(distinct refund_id), sum(qty), sum(gross_cents), sum(net_cents),
           sum(vat_cents)
      from rl where brand is not null group by brand
    union all
    select 'size_colour', size_colour, size_colour, count(distinct refund_id), sum(qty), sum(gross_cents),
           sum(net_cents), sum(vat_cents)
      from rl where size_colour is not null group by size_colour
  )
  select p_org, p_location, p_day, f.dim, f.key, max(f.label),
         sum(f.cnt)::int, sum(f.qty), sum(f.gross), sum(f.net), sum(f.vat), sum(f.disc), sum(f.tips),
         sum(f.rcnt)::int, sum(f.rqty), sum(f.rgross), sum(f.rnet), sum(f.rvat)
    from (
      select dim, key, label, cnt, qty, gross, net, vat, disc, tips,
             0::bigint as rcnt, 0::bigint as rqty, 0::bigint as rgross, 0::bigint as rnet, 0::bigint as rvat
        from sf
      union all
      select dim, key, label, 0, 0, 0, 0, 0, 0, 0, cnt, qty, gross, net, vat from rf
    ) f
   group by f.dim, f.key;
end
$$;
revoke all on function ops.rebuild_summary_day(uuid, uuid, date) from public, anon, authenticated;
grant execute on function ops.rebuild_summary_day(uuid, uuid, date) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.rebuild_dirty_summaries
-- Rebuilds up to p_limit marked days (oldest first) and clears each mark in the same transaction
-- as its rebuild. A sale that lands while a day is rebuilding marks it again. p_days_back > 0 also
-- marks every shop's last N days first (the nightly safety net: renamed products, late edits).
create function ops.rebuild_dirty_summaries(p_limit int default 200, p_days_back int default 0)
returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  v_n int := 0;
begin
  if p_days_back > 0 then
    insert into public.report_dirty_days (org_id, location_id, day)
    select l.org_id, l.id, ((now() at time zone l.timezone)::date - g)
      from public.locations l, generate_series(0, least(p_days_back, 30) - 1) g
    on conflict do nothing;
  end if;
  for d in
    select org_id, location_id, day from public.report_dirty_days
     order by day, marked_at limit greatest(p_limit, 1)
     for update skip locked
  loop
    delete from public.report_dirty_days
     where org_id = d.org_id and location_id = d.location_id and day = d.day;
    perform ops.rebuild_summary_day(d.org_id, d.location_id, d.day);
    v_n := v_n + 1;
  end loop;
  return v_n;
end
$$;
revoke all on function ops.rebuild_dirty_summaries(int, int) from public, anon, authenticated;
grant execute on function ops.rebuild_dirty_summaries(int, int) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- public.report_summary
-- One report, cut one way, over a range of shop-local days, optionally one row per day.
-- SECURITY INVOKER: the caller's RLS applies (managers and owners), and the role is also checked
-- here so a cashier gets an error instead of an empty table.
create function public.report_summary(
  p_org uuid, p_from date, p_to date, p_dim text,
  p_by_day boolean default false, p_location uuid default null
)
returns table (
  day date, key text, label text, sales_count bigint, qty bigint, gross_cents bigint, net_cents bigint,
  vat_cents bigint, discount_cents bigint, tips_cents bigint, refund_count bigint, refund_qty bigint,
  refund_gross_cents bigint, refund_net_cents bigint, refund_vat_cents bigint
)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'managers only' using errcode = '42501';
  end if;
  if p_dim is null or p_dim not in
     ('total', 'hour', 'tender', 'vat_rate', 'category', 'product', 'staff', 'brand', 'size_colour') then
    raise exception 'unknown report' using errcode = '22023';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'date range out of bounds' using errcode = '22023';
  end if;
  return query
  select x.day, x.key, x.label, x.sales_count, x.qty, x.gross_cents, x.net_cents, x.vat_cents,
         x.discount_cents, x.tips_cents, x.refund_count, x.refund_qty, x.refund_gross_cents,
         x.refund_net_cents, x.refund_vat_cents
    from (
      select case when p_by_day then s.day end as day, s.key, max(s.label) as label,
             sum(s.sales_count)::bigint as sales_count, sum(s.qty)::bigint as qty,
             sum(s.gross_cents)::bigint as gross_cents, sum(s.net_cents)::bigint as net_cents,
             sum(s.vat_cents)::bigint as vat_cents, sum(s.discount_cents)::bigint as discount_cents,
             sum(s.tips_cents)::bigint as tips_cents, sum(s.refund_count)::bigint as refund_count,
             sum(s.refund_qty)::bigint as refund_qty,
             sum(s.refund_gross_cents)::bigint as refund_gross_cents,
             sum(s.refund_net_cents)::bigint as refund_net_cents,
             sum(s.refund_vat_cents)::bigint as refund_vat_cents
        from public.daily_sales_summary s
       where s.org_id = p_org and s.dim = p_dim and s.day between p_from and p_to
         and (p_location is null or s.location_id = p_location)
       group by 1, s.key
    ) x
   order by x.day nulls first, x.key
   limit 5000;
end
$$;
revoke all on function public.report_summary(uuid, date, date, text, boolean, uuid) from public, anon;
grant execute on function public.report_summary(uuid, date, date, text, boolean, uuid) to authenticated;

-- ---------------------------------------------------------------- public.report_serials
-- Serial / IMEI numbers sold in a range, with the receipt, and whether the unit came back in a
-- refund. Read from the stored sale lines (a serial is per unit, so it is not summarised).
create function public.report_serials(
  p_org uuid, p_from date, p_to date, p_search text default null, p_limit int default 500
)
returns table (
  serial text, name text, receipt_seq int, register_name text, completed_at timestamptz, returned boolean
)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'managers only' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'date range out of bounds' using errcode = '22023';
  end if;
  if p_search is not null and char_length(p_search) > 60 then
    raise exception 'search too long' using errcode = '22023';
  end if;
  return query
  select l.serial, l.name, s.receipt_seq, rg.name, s.completed_at,
         exists (select 1 from public.refund_lines rl where rl.org_id = l.org_id and rl.sale_line_id = l.id)
    from public.sale_lines l
    join public.sales s on s.org_id = l.org_id and s.id = l.sale_id
    join public.locations loc on loc.org_id = s.org_id and loc.id = s.location_id
    join public.registers rg on rg.org_id = s.org_id and rg.id = s.register_id
   where l.org_id = p_org and l.serial is not null
     and s.completed_at >= (p_from - 1)::timestamp at time zone 'UTC'
     and s.completed_at < (p_to + 2)::timestamp at time zone 'UTC'
     and (s.completed_at at time zone loc.timezone)::date between p_from and p_to
     and (p_search is null or l.serial ilike '%' || replace(replace(p_search, '%', ''), '_', '') || '%')
   order by s.completed_at desc, l.serial
   limit least(greatest(p_limit, 1), 5000);
end
$$;
revoke all on function public.report_serials(uuid, date, date, text, int) from public, anon;
grant execute on function public.report_serials(uuid, date, date, text, int) to authenticated;

-- ---------------------------------------------------------------- public.report_covers
-- Restaurant: tabs opened, covers seated and what the bills from tabs took, per shop-local day.
-- Tabs have no location of their own (single location in v1): the shop's first location's clock.
create function public.report_covers(p_org uuid, p_from date, p_to date)
returns table (day date, tabs bigint, covers bigint, sales_cents bigint)
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_tz text;
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'managers only' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 400 then
    raise exception 'date range out of bounds' using errcode = '22023';
  end if;
  select l.timezone into v_tz from public.locations l where l.org_id = p_org order by l.created_at limit 1;
  v_tz := coalesce(v_tz, 'Europe/Dublin');
  return query
  with o as (
    select (e.at at time zone v_tz)::date as d, count(*)::bigint as tabs,
           coalesce(sum((e.detail ->> 'covers')::int), 0)::bigint as covers
      from public.tab_events e
     where e.org_id = p_org and e.kind = 'open'
       and e.at >= (p_from - 1)::timestamp at time zone 'UTC' and e.at < (p_to + 2)::timestamp at time zone 'UTC'
     group by 1
  ),
  b as (
    select (s.completed_at at time zone v_tz)::date as d, coalesce(sum(s.amount_due_cents), 0)::bigint as cents
      from public.sale_tabs st
      join public.sales s on s.org_id = st.org_id and s.id = st.sale_id
     where st.org_id = p_org
       and s.completed_at >= (p_from - 1)::timestamp at time zone 'UTC' and s.completed_at < (p_to + 2)::timestamp at time zone 'UTC'
     group by 1
  )
  select coalesce(o.d, b.d), coalesce(o.tabs, 0), coalesce(o.covers, 0), coalesce(b.cents, 0)
    from o full join b on b.d = o.d
   where coalesce(o.d, b.d) between p_from and p_to
   order by 1;
end
$$;
revoke all on function public.report_covers(uuid, date, date) from public, anon;
grant execute on function public.report_covers(uuid, date, date) to authenticated;
