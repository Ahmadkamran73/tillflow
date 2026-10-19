-- Hand-written: RLS, append-only triggers and the shift functions (Phase 2 step 2.3).
--
-- Shifts, cash movements, Z closes and the sale/refund links are written ONLY by ops.* functions,
-- authenticated with the paired till's device token. Clients get SELECT (managers and owners) and
-- nothing else. A Z close can never change: triggers refuse UPDATE/DELETE/TRUNCATE for every role.

-- ---------------------------------------------------------------- RLS and grants
alter table public.shifts enable row level security;
alter table public.cash_movements enable row level security;
alter table public.shift_closes enable row level security;
alter table public.shift_documents enable row level security;
revoke all on public.shifts, public.cash_movements, public.shift_closes, public.shift_documents
  from anon, authenticated;
grant select on public.shifts, public.cash_movements, public.shift_closes, public.shift_documents
  to authenticated;

create policy shifts_select on public.shifts for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy cash_movements_select on public.cash_movements for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy shift_closes_select on public.shift_closes for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy shift_documents_select on public.shift_documents for select to authenticated
  using (org_id in (select app.manager_org_ids()));

create trigger shifts_append_only before update or delete on public.shifts
  for each row execute function app.forbid_change();
create trigger cash_movements_append_only before update or delete on public.cash_movements
  for each row execute function app.forbid_change();
create trigger shift_closes_append_only before update or delete on public.shift_closes
  for each row execute function app.forbid_change();
create trigger shift_documents_append_only before update or delete on public.shift_documents
  for each row execute function app.forbid_change();
create trigger shifts_no_truncate before truncate on public.shifts
  for each statement execute function app.forbid_change();
create trigger cash_movements_no_truncate before truncate on public.cash_movements
  for each statement execute function app.forbid_change();
create trigger shift_closes_no_truncate before truncate on public.shift_closes
  for each statement execute function app.forbid_change();
create trigger shift_documents_no_truncate before truncate on public.shift_documents
  for each statement execute function app.forbid_change();

-- ---------------------------------------------------------------- app.shift_report
-- The report of one shift, worked out from the stored sale and refund snapshots (VAT is never looked
-- up again). SECURITY INVOKER: the closing function runs it as its owner, public.get_shift_report as
-- the manager (RLS applies). The twin of src/lib/money/shift.ts for the drawer sum.
create function app.shift_report(p_org uuid, p_shift uuid) returns jsonb
language sql stable set search_path = ''
as $$
  with sh as (
    select float_cents from public.shifts where org_id = p_org and id = p_shift
  ),
  sd as (
    select doc_id from public.shift_documents where org_id = p_org and shift_id = p_shift and kind = 'sale'
  ),
  rd as (
    select doc_id from public.shift_documents where org_id = p_org and shift_id = p_shift and kind = 'refund'
  ),
  s as (
    select s.* from public.sales s join sd on sd.doc_id = s.id where s.org_id = p_org
  ),
  r as (
    select r.* from public.refunds r join rd on rd.doc_id = r.id where r.org_id = p_org
  ),
  pay as (
    select p.* from public.payments p join sd on sd.doc_id = p.sale_id where p.org_id = p_org
  ),
  rpay as (
    select p.* from public.refund_payments p join rd on rd.doc_id = p.refund_id where p.org_id = p_org
  ),
  mv as (
    select kind, amount_cents from public.cash_movements where org_id = p_org and shift_id = p_shift
  ),
  d as (
    select
      (select float_cents from sh) as float_cents,
      coalesce((select sum(amount_cents) from pay where method = 'cash'), 0)::bigint as cash_sales,
      coalesce((select sum(amount_cents) from mv where kind = 'in'), 0)::bigint as cash_in,
      coalesce((select sum(amount_cents) from mv where kind = 'out'), 0)::bigint as cash_out,
      coalesce((select sum(amount_cents) from rpay where method = 'cash'), 0)::bigint as cash_refunds
  )
  select jsonb_build_object(
    'sales', jsonb_build_object(
      'count', (select count(*) from s),
      'items_total_cents', coalesce((select sum(items_total_cents) from s), 0),
      'vat_cents', coalesce((select sum(vat_cents) from s), 0),
      'non_vat_cents', coalesce((select sum(non_vat_cents) from s), 0),
      'rounding_cents', coalesce((select sum(cash_rounding_cents) from s), 0),
      'amount_due_cents', coalesce((select sum(amount_due_cents) from s), 0),
      'discount_cents', coalesce((select sum(l.discount_cents) from public.sale_lines l
                                   join sd on sd.doc_id = l.sale_id
                                  where l.org_id = p_org and l.kind = 'item'), 0)),
    'vat_by_rate', coalesce((
      select jsonb_agg(jsonb_build_object('rate_bp', x.rate_bp, 'net_cents', x.net, 'vat_cents', x.vat,
                                          'gross_cents', x.gross) order by x.rate_bp)
      from (select l.tax_rate_bp as rate_bp, sum(l.net_cents) as net, sum(l.vat_cents) as vat,
                   sum(l.gross_cents) as gross
              from public.sale_lines l join sd on sd.doc_id = l.sale_id
             where l.org_id = p_org and l.kind = 'item'
             group by l.tax_rate_bp) x), '[]'::jsonb),
    'tenders', coalesce((
      select jsonb_agg(jsonb_build_object('method', x.method, 'label', x.label, 'payments', x.n,
                                          'amount_cents', x.amt, 'tip_cents', x.tip) order by x.method, x.label)
      from (select method, coalesce(label, initcap(method)) as label, count(*) as n,
                   sum(amount_cents) as amt, sum(tip_cents) as tip
              from pay group by method, coalesce(label, initcap(method))) x), '[]'::jsonb),
    'tips_cents', coalesce((select sum(tip_cents) from pay), 0),
    'refunds', jsonb_build_object(
      'count', (select count(*) from r),
      'amount_cents', coalesce((select sum(amount_cents) from r), 0),
      'credit_cents', coalesce((select sum(credit_cents) from r), 0),
      'vat_cents', coalesce((select sum(vat_cents) from r), 0),
      'by_kind', coalesce((
        select jsonb_agg(jsonb_build_object('kind', x.kind, 'count', x.n, 'amount_cents', x.amt)
                         order by x.kind)
        from (select kind, count(*) as n, sum(amount_cents) as amt from r group by kind) x), '[]'::jsonb)),
    'refund_vat_by_rate', coalesce((
      select jsonb_agg(jsonb_build_object('rate_bp', x.rate_bp, 'net_cents', x.net, 'vat_cents', x.vat,
                                          'gross_cents', x.gross) order by x.rate_bp)
      from (select l.tax_rate_bp as rate_bp, sum(l.net_cents) as net, sum(l.vat_cents) as vat,
                   sum(l.gross_cents) as gross
              from public.refund_lines l join rd on rd.doc_id = l.refund_id
             where l.org_id = p_org and l.kind = 'item'
             group by l.tax_rate_bp) x), '[]'::jsonb),
    'refund_tenders', coalesce((
      select jsonb_agg(jsonb_build_object('method', x.method, 'label', x.label, 'refunds', x.n,
                                          'amount_cents', x.amt, 'tip_cents', x.tip) order by x.method, x.label)
      from (select method, coalesce(label, initcap(method)) as label, count(*) as n,
                   sum(amount_cents) as amt, sum(tip_cents) as tip
              from rpay group by method, coalesce(label, initcap(method))) x), '[]'::jsonb),
    'drawer', jsonb_build_object(
      'float_cents', d.float_cents,
      'cash_sales_cents', d.cash_sales,
      'cash_in_cents', d.cash_in,
      'cash_out_cents', d.cash_out,
      'cash_refunds_cents', d.cash_refunds,
      'expected_cents', d.float_cents + d.cash_sales + d.cash_in - d.cash_out - d.cash_refunds)
  )
  from d
$$;
revoke all on function app.shift_report(uuid, uuid) from public, anon, authenticated;
grant execute on function app.shift_report(uuid, uuid) to service_role, tillflow_ops, authenticated;

-- ---------------------------------------------------------------- public.get_shift_report
-- Managers and owners: the stored Z of a closed shift, or a live X for an open one.
create function public.get_shift_report(p_org uuid, p_shift uuid) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  v_close public.shift_closes%rowtype;
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'managers only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.shifts where org_id = p_org and id = p_shift) then
    return null;
  end if;
  select * into v_close from public.shift_closes where org_id = p_org and shift_id = p_shift;
  if found then
    return v_close.report || jsonb_build_object('closed', true, 'z_seq', v_close.z_seq,
      'closed_at', v_close.closed_at, 'review_flags', to_jsonb(v_close.review_flags));
  end if;
  return app.shift_report(p_org, p_shift) || jsonb_build_object('closed', false);
end
$$;
revoke all on function public.get_shift_report(uuid, uuid) from public, anon;
grant execute on function public.get_shift_report(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- ops.record_shift_event
-- One entry point for the till's shift outbox. e = {kind: open|cash|close, id, org_id, register_id,
-- user_id, at, ...}. Idempotent by id ('duplicate'). A close gets its Z number here. Errors: 42501 not this till / not staff,
-- 22023 a value the database refuses, TF001 a shift is already open on this till.
create function ops.record_shift_event(p_token_hash text, e jsonb) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_kind text := e ->> 'kind';
  v_org uuid := (e ->> 'org_id')::uuid;
  v_id uuid := (e ->> 'id')::uuid;
  v_reg uuid := (e ->> 'register_id')::uuid;
  v_user uuid := (e ->> 'user_id')::uuid;
  v_at timestamptz := (e ->> 'at')::timestamptz;
  v_loc uuid;
  v_shift uuid := (e ->> 'shift_id')::uuid;
  v_report jsonb;
  v_expected bigint;
  v_counted int;
  v_flags text[] := '{}';
  v_z int;
begin
  if p_token_hash is null or not exists (
       select 1 from app.device_register(p_token_hash) d
        where d.org_id = v_org and d.register_id = v_reg) then
    raise exception 'not this till' using errcode = '42501';
  end if;
  if not app.is_member(v_user, v_org) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if num_nulls(v_id, v_at) > 0 or v_kind not in ('open', 'cash', 'close')
     or v_at < now() - interval '90 days' or v_at > now() + interval '10 minutes' then
    raise exception 'bad shift event' using errcode = '22023';
  end if;
  -- Serialise the events of one till.
  select r.location_id into v_loc from public.registers r
   where r.id = v_reg and r.org_id = v_org for update;
  if v_loc is null then
    raise exception 'unknown register' using errcode = '42501';
  end if;

  if v_kind = 'open' then
    if exists (select 1 from public.shifts where id = v_id) then
      if exists (select 1 from public.shifts where id = v_id and org_id = v_org and register_id = v_reg) then
        return 'duplicate';
      end if;
      raise exception 'shift id in use' using errcode = '23505';
    end if;
    if exists (select 1 from public.shifts s
                where s.org_id = v_org and s.register_id = v_reg
                  and not exists (select 1 from public.shift_closes c where c.shift_id = s.id)) then
      raise exception 'a shift is already open on this till' using errcode = 'TF001';
    end if;
    insert into public.shifts (id, org_id, register_id, location_id, opened_by, opened_at, float_cents)
    values (v_id, v_org, v_reg, v_loc, v_user, v_at, (e ->> 'float_cents')::int);
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (gen_random_uuid(), v_org, v_user, 'shift.opened', 'shift', v_id,
            jsonb_build_object('register_id', v_reg, 'float_cents', (e ->> 'float_cents')::int));
    return 'recorded';
  end if;

  if not exists (select 1 from public.shifts where id = v_shift and org_id = v_org and register_id = v_reg) then
    raise exception 'unknown shift' using errcode = '22023';
  end if;

  if v_kind = 'cash' then
    if exists (select 1 from public.cash_movements where id = v_id) then
      if exists (select 1 from public.cash_movements where id = v_id and org_id = v_org and shift_id = v_shift) then
        return 'duplicate';
      end if;
      raise exception 'movement id in use' using errcode = '23505';
    end if;
    if exists (select 1 from public.shift_closes where shift_id = v_shift) then
      raise exception 'shift is closed' using errcode = '22023';
    end if;
    insert into public.cash_movements (id, org_id, shift_id, kind, amount_cents, note, cashier_user_id, at)
    values (v_id, v_org, v_shift, e ->> 'movement', (e ->> 'amount_cents')::int, e ->> 'note', v_user, v_at);
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (gen_random_uuid(), v_org, v_user, 'shift.cash_' || (e ->> 'movement'), 'shift', v_shift,
            jsonb_build_object('movement_id', v_id, 'amount_cents', (e ->> 'amount_cents')::int));
    return 'recorded';
  end if;

  -- close
  if exists (select 1 from public.shift_closes where id = v_id or shift_id = v_shift) then
    if exists (select 1 from public.shift_closes where id = v_id and org_id = v_org and shift_id = v_shift) then
      return 'duplicate';
    end if;
    raise exception 'shift already closed' using errcode = '23505';
  end if;
  v_counted := (e ->> 'counted_cents')::int;
  -- The Z number is the server's: the next one for this till, gap-free under the register lock above.
  select coalesce(max(z_seq), 0) + 1 into v_z from public.shift_closes
   where org_id = v_org and register_id = v_reg;
  v_report := app.shift_report(v_org, v_shift);
  v_expected := (v_report -> 'drawer' ->> 'expected_cents')::bigint;
  if (e ->> 'client_expected_cents') is distinct from v_expected::text then
    v_flags := array_append(v_flags, 'z_differs');
  end if;
  -- Sales or refunds the server refused are not in the report, but their cash may be in the drawer:
  -- the over/short cannot be called clean.
  if coalesce((e ->> 'rejected_count')::int, 0) > 0 then
    v_flags := array_append(v_flags, 'rejected_excluded');
  end if;
  if (e ->> 'sale_count')::int is distinct from (v_report -> 'sales' ->> 'count')::int
     or (e ->> 'refund_count')::int is distinct from (v_report -> 'refunds' ->> 'count')::int then
    v_flags := array_append(v_flags, 'counts_differ');
  end if;
  v_report := v_report || jsonb_build_object(
    'counted_cents', v_counted, 'over_short_cents', v_counted - v_expected);
  insert into public.shift_closes (id, org_id, shift_id, register_id, z_seq, closed_by, closed_at,
                                   counted_cents, expected_cents, over_short_cents, report, review_flags)
  values (v_id, v_org, v_shift, v_reg, v_z, v_user, v_at, v_counted, v_expected,
          v_counted - v_expected, v_report, v_flags);
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (gen_random_uuid(), v_org, v_user, 'shift.closed', 'shift', v_shift,
          jsonb_build_object('z_seq', v_z, 'counted_cents', v_counted,
                             'expected_cents', v_expected, 'over_short_cents', v_counted - v_expected,
                             'review_flags', to_jsonb(v_flags)));
  return 'recorded';
end
$$;
revoke all on function ops.record_shift_event(text, jsonb) from public, anon, authenticated;
grant execute on function ops.record_shift_event(text, jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- sale / refund wrappers
-- The big record functions stay as they are (renamed *_core, same grants). The wrappers add the
-- shift link: p -> 'shift_id' (optional, for tills from before shifts) must be a shift of this till.
alter function ops.record_sale(jsonb, text) rename to record_sale_core;
alter function ops.record_refund(jsonb, text) rename to record_refund_core;

create function ops.record_sale(p jsonb, p_token_hash text default null) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_shift uuid := nullif(p ->> 'shift_id', '')::uuid;
  v_org uuid := (p -> 'sale' ->> 'org_id')::uuid;
  v_reg uuid := (p -> 'sale' ->> 'register_id')::uuid;
  v_res text;
begin
  if v_shift is not null and not exists (
       select 1 from public.shifts where id = v_shift and org_id = v_org and register_id = v_reg) then
    raise exception 'unknown shift' using errcode = '22023';
  end if;
  if v_shift is not null and exists (select 1 from public.shift_closes where shift_id = v_shift)
     and not exists (select 1 from public.shift_documents where doc_id = (p -> 'sale' ->> 'id')::uuid and shift_id = v_shift) then
    raise exception 'shift is closed' using errcode = '22023';
  end if;
  v_res := ops.record_sale_core(p, p_token_hash);
  if v_shift is not null and v_res in ('created', 'duplicate') then
    insert into public.shift_documents (doc_id, org_id, shift_id, kind)
    values ((p -> 'sale' ->> 'id')::uuid, v_org, v_shift, 'sale')
    on conflict do nothing;
  end if;
  return v_res;
end
$$;
create function ops.record_refund(p jsonb, p_token_hash text) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_shift uuid := nullif(p ->> 'shift_id', '')::uuid;
  v_org uuid := (p -> 'refund' ->> 'org_id')::uuid;
  v_reg uuid := (p -> 'refund' ->> 'register_id')::uuid;
  v_res text;
begin
  if v_shift is not null and not exists (
       select 1 from public.shifts where id = v_shift and org_id = v_org and register_id = v_reg) then
    raise exception 'unknown shift' using errcode = '22023';
  end if;
  if v_shift is not null and exists (select 1 from public.shift_closes where shift_id = v_shift)
     and not exists (select 1 from public.shift_documents where doc_id = (p -> 'refund' ->> 'id')::uuid and shift_id = v_shift) then
    raise exception 'shift is closed' using errcode = '22023';
  end if;
  v_res := ops.record_refund_core(p, p_token_hash);
  if v_shift is not null and v_res in ('created', 'duplicate') then
    insert into public.shift_documents (doc_id, org_id, shift_id, kind)
    values ((p -> 'refund' ->> 'id')::uuid, v_org, v_shift, 'refund')
    on conflict do nothing;
  end if;
  return v_res;
end
$$;
revoke all on function ops.record_sale(jsonb, text) from public, anon, authenticated;
grant execute on function ops.record_sale(jsonb, text) to service_role, tillflow_ops;
revoke all on function ops.record_refund(jsonb, text) from public, anon, authenticated;
grant execute on function ops.record_refund(jsonb, text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.shift_z_email_data
-- What the Z email job needs: the stored report, the shop and till names and the owners' addresses.
-- This is the one place outside src/lib/auth that reads the login accounts (auth.users): swap it
-- with the auth provider. Addresses are returned to the job and never logged.
create function ops.shift_z_email_data(p_shift uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_close public.shift_closes%rowtype;
begin
  select * into v_close from public.shift_closes where shift_id = p_shift;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'org_id', v_close.org_id,
    'org_name', (select o.name from public.organisations o where o.id = v_close.org_id),
    'timezone', (select l.timezone from public.shifts s join public.locations l
                   on l.org_id = s.org_id and l.id = s.location_id where s.id = p_shift),
    'register_name', (select r.name from public.registers r where r.id = v_close.register_id),
    'z_seq', v_close.z_seq,
    'closed_at', v_close.closed_at,
    'review_flags', to_jsonb(v_close.review_flags),
    'report', v_close.report,
    'emails', coalesce((
      select jsonb_agg(distinct lower(u.email))
      from public.memberships m
      join auth.users u on u.id = m.user_id
      where m.org_id = v_close.org_id and m.role = 'owner' and u.email is not null), '[]'::jsonb));
end
$$;
revoke all on function ops.shift_z_email_data(uuid) from public, anon, authenticated;
grant execute on function ops.shift_z_email_data(uuid) to service_role, tillflow_ops;
