-- Hand-written: RLS and functions for the restaurant flow (Phase 2, step 2.6).
--
-- Floors and tables are edited by managers/owners only, in one call (public.save_floor_plan,
-- SECURITY DEFINER with an explicit role check, so it can write the audit row; clients have
-- SELECT only on the tables); nothing is ever deleted, only archived. A till reads them
-- through ops.device_restaurant_meta. Tab events are written ONLY by ops.record_tab_event with a
-- device token and are append-only; they carry no money (a tab's money is in the sales paid from it,
-- linked in sale_tabs by the ops.record_sale wrapper). The service charge is a plain taxed sale line
-- (see src/lib/money/basket.ts), so ops.record_sale_core and the refund/shift/VAT code are unchanged.

-- ---------------------------------------------------------------- RLS and grants
alter table public.floors enable row level security;
alter table public.restaurant_tables enable row level security;
alter table public.tab_events enable row level security;
alter table public.sale_tabs enable row level security;
revoke all on public.floors, public.restaurant_tables, public.tab_events, public.sale_tabs
  from anon, authenticated;
grant select on public.floors, public.restaurant_tables, public.tab_events, public.sale_tabs to authenticated;

create policy floors_select on public.floors for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy restaurant_tables_select on public.restaurant_tables for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy tab_events_select on public.tab_events for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy sale_tabs_select on public.sale_tabs for select to authenticated
  using (org_id in (select app.manager_org_ids()));

create trigger floors_touch before update on public.floors
  for each row execute function app.touch_updated_at();
create trigger restaurant_tables_touch before update on public.restaurant_tables
  for each row execute function app.touch_updated_at();
create trigger tab_events_append_only before update or delete on public.tab_events
  for each row execute function app.forbid_change();
create trigger tab_events_no_truncate before truncate on public.tab_events
  for each statement execute function app.forbid_change();
create trigger sale_tabs_append_only before update or delete on public.sale_tabs
  for each row execute function app.forbid_change();
create trigger sale_tabs_no_truncate before truncate on public.sale_tabs
  for each statement execute function app.forbid_change();

-- A live table name is unique on its floor (two "T4"s would be a till mistake waiting to happen).
create unique index restaurant_tables_live_name_key
  on public.restaurant_tables (org_id, floor_id, lower(name)) where archived_at is null;
create unique index floors_live_name_key
  on public.floors (org_id, location_id, lower(name)) where archived_at is null;

-- A tab opens once: a second open event for the same tab cannot inflate covers.
create unique index tab_events_one_open_key on public.tab_events (org_id, tab_id) where kind = 'open';

-- ---------------------------------------------------------------- public.save_floor_plan
-- The whole plan in one call: p_floors = [{id, name, sort, tables: [{id, name, seats, shape, x, y,
-- w, h}]}]. Anything not listed is archived, anything listed is created or updated. ids are made by
-- the editor (UUIDs). SECURITY DEFINER: the role check below is the gate, and every write is limited
-- to p_org. Live tables of one floor must not overlap on the grid.
create function public.save_floor_plan(p_org uuid, p_floors jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_loc uuid;
  v_floor jsonb;
  v_table jsonb;
  v_n_floors int;
  v_n_tables int := 0;
begin
  if p_org is null or p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_floors is null or jsonb_typeof(p_floors) <> 'array' or jsonb_array_length(p_floors) > 10 then
    raise exception 'bad input' using errcode = '22023';
  end if;
  select l.id into v_loc from public.locations l where l.org_id = p_org order by l.created_at limit 1;
  if v_loc is null then
    raise exception 'no location' using errcode = '22023';
  end if;
  v_n_floors := jsonb_array_length(p_floors);

  -- Archive what is no longer listed first, so a name can be reused.
  update public.restaurant_tables t set archived_at = coalesce(t.archived_at, now())
   where t.org_id = p_org and t.archived_at is null
     and t.id not in (select (tb.v ->> 'id')::uuid
                        from jsonb_array_elements(p_floors) as fl(v),
                             jsonb_array_elements(coalesce(fl.v -> 'tables', '[]'::jsonb)) as tb(v));
  update public.floors f set archived_at = coalesce(f.archived_at, now())
   where f.org_id = p_org and f.archived_at is null
     and f.id not in (select (fl.v ->> 'id')::uuid from jsonb_array_elements(p_floors) as fl(v));

  for v_floor in select * from jsonb_array_elements(p_floors) loop
    if jsonb_typeof(v_floor -> 'tables') is distinct from 'array'
       or jsonb_array_length(v_floor -> 'tables') > 60 then
      raise exception 'bad input' using errcode = '22023';
    end if;
    insert into public.floors (id, org_id, location_id, name, sort)
    values ((v_floor ->> 'id')::uuid, p_org, v_loc, btrim(v_floor ->> 'name'),
            coalesce((v_floor ->> 'sort')::int, 0))
    on conflict (id) do update
      set name = excluded.name, sort = excluded.sort, archived_at = null
      where public.floors.org_id = p_org;
    if not exists (select 1 from public.floors where id = (v_floor ->> 'id')::uuid and org_id = p_org) then
      raise exception 'id in use' using errcode = '23505';
    end if;
    for v_table in select * from jsonb_array_elements(v_floor -> 'tables') loop
      v_n_tables := v_n_tables + 1;
      insert into public.restaurant_tables (id, org_id, floor_id, name, seats, shape, x, y, w, h)
      values ((v_table ->> 'id')::uuid, p_org, (v_floor ->> 'id')::uuid, btrim(v_table ->> 'name'),
              (v_table ->> 'seats')::int, coalesce(v_table ->> 'shape', 'square'),
              (v_table ->> 'x')::int, (v_table ->> 'y')::int,
              (v_table ->> 'w')::int, (v_table ->> 'h')::int)
      on conflict (id) do update
        set floor_id = excluded.floor_id, name = excluded.name, seats = excluded.seats,
            shape = excluded.shape, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
            archived_at = null
        where public.restaurant_tables.org_id = p_org;
      if not exists (select 1 from public.restaurant_tables
                      where id = (v_table ->> 'id')::uuid and org_id = p_org) then
        raise exception 'id in use' using errcode = '23505';
      end if;
    end loop;
  end loop;

  -- No two live tables on a floor may share a grid cell.
  if exists (
    select 1 from public.restaurant_tables a
    join public.restaurant_tables b
      on b.org_id = a.org_id and b.floor_id = a.floor_id and b.id > a.id and b.archived_at is null
     and a.x < b.x + b.w and b.x < a.x + a.w and a.y < b.y + b.h and b.y < a.y + a.h
    where a.org_id = p_org and a.archived_at is null) then
    raise exception 'tables overlap' using errcode = '22023';
  end if;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (gen_random_uuid(), p_org, (select app.current_user_id()), 'floor_plan.saved', 'organisation',
          p_org, jsonb_build_object('floors', v_n_floors, 'tables', v_n_tables));
end
$$;
revoke all on function public.save_floor_plan(uuid, jsonb) from public, anon;
grant execute on function public.save_floor_plan(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------- public.set_service_charge
create function public.set_service_charge(p_org uuid, p_bp integer, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_before integer;
begin
  if v_user is null or p_org is null or p_audit_id is null
     or not exists (select 1 from app.owner_org_ids() o where o = p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_bp is null or p_bp not between 0 and 2500 then
    raise exception 'bad input' using errcode = '22023';
  end if;
  select service_charge_bp into v_before from public.organisations where id = p_org for update;
  update public.organisations set service_charge_bp = p_bp where id = p_org;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, before, after)
  values (p_audit_id, p_org, v_user, 'organisation.service_charge_changed', 'organisation', p_org,
          jsonb_build_object('bp', v_before), jsonb_build_object('bp', p_bp));
end
$$;
revoke all on function public.set_service_charge(uuid, integer, uuid) from public, anon;
grant execute on function public.set_service_charge(uuid, integer, uuid) to authenticated;

-- ---------------------------------------------------------------- ops.device_restaurant_meta
-- What a till needs for table service: the service charge and the live floor plan.
create function ops.device_restaurant_meta(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'service_charge_bp', (select o.service_charge_bp from public.organisations o where o.id = d.org_id),
    'floors', coalesce((
        select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name, 'sort', f.sort)
                         order by f.sort, f.name)
        from public.floors f
        where f.org_id = d.org_id and f.location_id = d.location_id and f.archived_at is null),
        '[]'::jsonb),
    'tables', coalesce((
        select jsonb_agg(jsonb_build_object('id', t.id, 'floor_id', t.floor_id, 'name', t.name,
                                            'seats', t.seats, 'shape', t.shape, 'x', t.x, 'y', t.y,
                                            'w', t.w, 'h', t.h) order by t.name)
        from public.restaurant_tables t
        join public.floors f on f.org_id = t.org_id and f.id = t.floor_id
        where t.org_id = d.org_id and t.archived_at is null
          and f.location_id = d.location_id and f.archived_at is null), '[]'::jsonb));
end
$$;
revoke all on function ops.device_restaurant_meta(text) from public, anon, authenticated;
grant execute on function ops.device_restaurant_meta(text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.record_tab_event
-- One event of a restaurant tab from a paired till. Idempotent by id. The detail is rebuilt here
-- from an allow-list of small facts (never taken as sent), so nothing personal can be stored.
create function ops.record_tab_event(p_token_hash text, p jsonb) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  v_id uuid := (p ->> 'id')::uuid;
  v_tab uuid := (p ->> 'tab_id')::uuid;
  v_kind text := p ->> 'kind';
  v_user uuid := (p ->> 'cashier_user_id')::uuid;
  v_at timestamptz := (p ->> 'at')::timestamptz;
  v_det jsonb := coalesce(p -> 'detail', '{}'::jsonb);
  v_clean jsonb := '{}'::jsonb;
  v_key text;
  v_n int;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    raise exception 'unknown device' using errcode = '42501';
  end if;
  if v_kind is null or v_kind not in ('open', 'send', 'fire', 'transfer', 'merge', 'close', 'void')
     or jsonb_typeof(v_det) <> 'object' or v_id is null or v_tab is null then
    raise exception 'bad event' using errcode = '22023';
  end if;
  if not app.is_member(v_user, d.org_id) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if v_at is null or v_at < now() - interval '90 days' or v_at > now() + interval '10 minutes' then
    raise exception 'bad time' using errcode = '22023';
  end if;
  -- Allow-listed, size-limited facts.
  -- Table names are kept only if they are a real table of this shop (free text could hold a name).
  foreach v_key in array array['table', 'from', 'to'] loop
    if v_det ? v_key and exists (select 1 from public.restaurant_tables t
                                  where t.org_id = d.org_id
                                    and lower(t.name) = lower(btrim(v_det ->> v_key))) then
      v_clean := v_clean || jsonb_build_object(v_key, left(btrim(v_det ->> v_key), 20));
    end if;
  end loop;
  foreach v_key in array array['covers', 'course', 'lines', 'parts'] loop
    if v_det ? v_key then
      v_n := (v_det ->> v_key)::int;
      if v_n not between 0 and (case when v_key = 'covers' then 30 else 1000 end) then
        raise exception 'bad event' using errcode = '22023';
      end if;
      v_clean := v_clean || jsonb_build_object(v_key, v_n);
    end if;
  end loop;
  if v_det ? 'merged_tab' then
    v_clean := v_clean || jsonb_build_object('merged_tab', (v_det ->> 'merged_tab')::uuid);
  end if;

  insert into public.tab_events (id, org_id, tab_id, register_id, kind, cashier_user_id, at, detail)
  values (v_id, d.org_id, v_tab, d.register_id, v_kind, v_user, v_at, v_clean)
  on conflict (id) do nothing;
  get diagnostics v_n = row_count;
  if v_n = 1 then
    return 'recorded';
  end if;
  if exists (select 1 from public.tab_events
              where id = v_id and org_id = d.org_id and register_id = d.register_id) then
    return 'duplicate';
  end if;
  raise exception 'event id in use' using errcode = '23505';
end
$$;
revoke all on function ops.record_tab_event(text, jsonb) from public, anon, authenticated;
grant execute on function ops.record_tab_event(text, jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.record_sale: tab link
-- Wraps the customer wrapper from 0037. p -> 'tab_id' (optional) links a NEW sale to its tab; a
-- replay cannot attach one afterwards. The link carries no money and never refuses a sale.
alter function ops.record_sale(jsonb, text) rename to record_sale_customer;

create function ops.record_sale(p jsonb, p_token_hash text default null) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_tab uuid := nullif(p ->> 'tab_id', '')::uuid;
  v_org uuid := (p -> 'sale' ->> 'org_id')::uuid;
  v_res text;
begin
  v_res := ops.record_sale_customer(p, p_token_hash);
  if v_tab is not null and v_res = 'created' then
    insert into public.sale_tabs (sale_id, org_id, tab_id)
    values ((p -> 'sale' ->> 'id')::uuid, v_org, v_tab)
    on conflict do nothing;
  end if;
  return v_res;
end
$$;
revoke all on function ops.record_sale(jsonb, text) from public, anon, authenticated;
grant execute on function ops.record_sale(jsonb, text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- public.tab_covers
-- Covers and spend per cover for the dashboard: covers from the tabs' open events, spend from the
-- sales paid from those tabs. SECURITY INVOKER: managers only through RLS.
create function public.tab_covers(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (tabs bigint, covers bigint, sales_cents bigint)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'managers only' using errcode = '42501';
  end if;
  return query
  select (select count(*) from public.tab_events e
           where e.org_id = p_org and e.kind = 'open' and e.at >= p_from and e.at < p_to),
         (select coalesce(sum((e.detail ->> 'covers')::int), 0)::bigint from public.tab_events e
           where e.org_id = p_org and e.kind = 'open' and e.at >= p_from and e.at < p_to),
         (select coalesce(sum(s.amount_due_cents), 0)::bigint from public.sale_tabs st
            join public.sales s on s.org_id = st.org_id and s.id = st.sale_id
           where st.org_id = p_org and s.completed_at >= p_from and s.completed_at < p_to);
end
$$;
revoke all on function public.tab_covers(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.tab_covers(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------- void of a sent line
-- A line already sent to the kitchen or bar can only be taken off with a manager PIN. The till queues
-- a register event (kind void_item) that carries the server-issued approval; ops.record_register_events
-- verifies it exactly as it does for a no-sale drawer open and writes an audit row (tab.void_item).
-- Without an approval id (made offline) the row says unverified_offline and names no approver.
drop function ops.issue_approval(text, uuid, text, uuid, integer);
create function ops.issue_approval(
  p_token_hash text, p_user uuid, p_purpose text,
  p_sale uuid default null, p_max_cents integer default null
) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  v_id uuid := gen_random_uuid();
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    raise exception 'unknown device' using errcode = '42501';
  end if;
  if p_purpose is null or p_purpose not in ('discount', 'no_sale', 'refund', 'void_item') then
    raise exception 'bad purpose' using errcode = '22023';
  end if;
  if (p_purpose = 'refund') <> (p_sale is not null and p_max_cents is not null)
     or (p_purpose <> 'refund' and (p_sale is not null or p_max_cents is not null))
     or p_max_cents < 0 then
    raise exception 'a refund approval names its sale and a value' using errcode = '22023';
  end if;
  if not app.is_manager(p_user, d.org_id) then
    raise exception 'not a manager' using errcode = '42501';
  end if;
  insert into public.register_approvals (id, org_id, register_id, approver_user_id, purpose, sale_id, max_cents)
  values (v_id, d.org_id, d.register_id, p_user, p_purpose, p_sale, p_max_cents);
  return v_id;
end
$$;
revoke all on function ops.issue_approval(text, uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function ops.issue_approval(text, uuid, text, uuid, integer) to service_role, tillflow_ops;

-- (replaced: same as 0023 except for the void_item kind, purpose and audit action)
create or replace function ops.record_register_events(p_token_hash text, p_events jsonb)
returns setof uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  e jsonb;
  v_id uuid;
  v_cashier uuid;
  v_approval uuid;
  v_claimed uuid;
  v_approver uuid;
  v_at timestamptz;
  v_kind text;
  v_detail jsonb;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    raise exception 'unknown device' using errcode = '42501';
  end if;

  for e in select * from jsonb_array_elements(p_events) loop
    v_id := (e ->> 'id')::uuid;
    v_kind := e ->> 'kind';
    v_cashier := (e ->> 'cashier_user_id')::uuid;
    v_approval := nullif(e ->> 'approval_id', '')::uuid;
    v_claimed := nullif(e ->> 'claimed_approver', '')::uuid;
    v_at := (e ->> 'at')::timestamptz;
    if v_kind not in ('no_sale', 'refund_override', 'void_item') then
      raise exception 'unknown event kind' using errcode = '22023';
    end if;
    if not app.is_member(v_cashier, d.org_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;

    -- A replay: already recorded for this shop, nothing to do (the approval was spent the first time).
    if exists (select 1 from public.audit_log where id = v_id and org_id = d.org_id) then
      return next v_id;
      continue;
    end if;

    v_approver := null;
    if v_approval is not null then
      -- Verified: the approver is whoever the SERVER saw enter a manager PIN on this till.
      select a.approver_user_id into v_approver
        from public.register_approvals a
       where a.id = v_approval and a.org_id = d.org_id and a.register_id = d.register_id
         and a.purpose = case v_kind when 'no_sale' then 'no_sale' when 'void_item' then 'void_item' else 'refund' end
         and a.consumed_at is null
         and v_at between a.created_at - interval '1 minute' and a.created_at + interval '30 minutes'
       for update;
      if v_approver is null or not app.is_manager(v_approver, d.org_id) then
        raise exception 'approval not valid' using errcode = '42501';
      end if;
      update public.register_approvals set consumed_at = now(), consumed_for = v_id where id = v_approval;
    elsif v_claimed is not null and not app.is_manager(v_claimed, d.org_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;

    -- A voided item is recorded from an allow-list (product name, quantity, course, a real table
    -- name); anything else the till sent is dropped, so no free text reaches the audit log.
    v_detail := coalesce(e -> 'detail', '{}'::jsonb);
    if v_kind = 'void_item' then
      v_detail := jsonb_strip_nulls(jsonb_build_object(
        'item', left(btrim(coalesce(v_detail ->> 'item', '')), 80),
        'qty', case when (v_detail ->> 'qty') ~ '^[0-9]{1,4}$' then (v_detail ->> 'qty')::int end,
        'course', case when (v_detail ->> 'course') ~ '^[0-9]{1,2}$' then (v_detail ->> 'course')::int end,
        'table', (select t.name from public.restaurant_tables t
                   where t.org_id = d.org_id
                     and lower(t.name) = lower(btrim(coalesce(v_detail ->> 'table', ''))) limit 1)));
    end if;

    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (v_id, d.org_id, v_cashier,
            case v_kind when 'no_sale' then 'register.no_sale' when 'void_item' then 'tab.void_item' else 'override.refund' end,
            'register', d.register_id,
            jsonb_build_object(
              'approval', case when v_approval is not null then 'pin_verified' else 'unverified_offline' end,
              'approved_by', v_approver,
              -- Offline the till cannot prove the PIN: the manager it names is a claim, labelled as one.
              'claimed_approver', case when v_approval is null then v_claimed end,
              'at', e ->> 'at',
              'detail', v_detail))
    on conflict (id) do nothing;
    -- Only report ids that are recorded for THIS shop (a clashing id in another shop is not ours).
    if exists (select 1 from public.audit_log where id = v_id and org_id = d.org_id) then
      return next v_id;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------- Z-report: no phantom discounts
-- A service-charge line is stored with the item's quantity and a unit price rounded up, so its
-- "discount" column holds up to qty-1 rounding cents. The Z-report's discount total skips those
-- lines (no variant); everything else in the report is unchanged from 0033.
create or replace function app.shift_report(p_org uuid, p_shift uuid) returns jsonb
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
                                  where l.org_id = p_org and l.kind = 'item'
                                    -- A service-charge line has no variant: the cents on it are rounding, not a discount.
                                    and l.variant_id is not null), 0)),
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
