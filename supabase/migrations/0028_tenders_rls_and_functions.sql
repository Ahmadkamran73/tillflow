-- Step 2.1: tender types (cash / card on the shop's own terminal / voucher), split payments.
-- Hand-written: RLS, grants, triggers, seeds and functions for 0025_tender_types.
-- Card data never reaches Tillflow: a card tender records an amount, a type label and an optional
-- terminal reference (the payments_provider_ref check refuses anything that looks like a card number).

-- ---------------------------------------------------------------- tender_types
alter table public.tender_types enable row level security;
revoke all on public.tender_types from anon, authenticated;
grant select on public.tender_types to authenticated;
-- method and location never change; archived types stay (payments point at them).
grant insert (id, org_id, location_id, method, label, sort) on public.tender_types to authenticated;
grant update (label, sort, archived_at) on public.tender_types to authenticated;

create policy tender_types_select on public.tender_types for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy tender_types_insert on public.tender_types for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy tender_types_update on public.tender_types for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));
-- No delete policy and no delete grant: archive instead.

create trigger tender_types_touch before update on public.tender_types
  for each row execute function app.touch_updated_at();

-- The one cash type of a location is built in and cannot be archived.
create function app.guard_tender_types() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.method = 'cash' and new.archived_at is not null then
    raise exception 'the cash payment type cannot be archived' using errcode = '23514';
  end if;
  -- A second cash type is refused by the unique index tender_types_one_cash_key.
  return new;
end
$$;
create trigger tender_types_guard before insert or update on public.tender_types
  for each row execute function app.guard_tender_types();

-- ---------------------------------------------------------------- seed per location
create function app.seed_tender_types() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.tender_types (id, org_id, location_id, method, label, sort)
  values (gen_random_uuid(), new.org_id, new.id, 'cash', 'Cash', 0),
         (gen_random_uuid(), new.org_id, new.id, 'card', 'Card', 10),
         (gen_random_uuid(), new.org_id, new.id, 'voucher', 'Voucher', 20);
  return new;
end
$$;
revoke all on function app.seed_tender_types() from public, anon, authenticated;
create trigger locations_seed_tender_types after insert on public.locations
  for each row execute function app.seed_tender_types();

-- Existing locations.
insert into public.tender_types (id, org_id, location_id, method, label, sort)
select gen_random_uuid(), l.org_id, l.id, v.method, v.label, v.sort
from public.locations l
cross join (values ('cash', 'Cash', 0), ('card', 'Card', 10), ('voucher', 'Voucher', 20)) as v(method, label, sort)
where not exists (select 1 from public.tender_types t where t.location_id = l.id and t.method = v.method);

-- ---------------------------------------------------------------- ops.device_tender_types
-- The payment types of this till's location (archived ones flagged) and the shop's business type
-- (tips are only taken in cafés and restaurants). Used by the catalogue feed and by sale sync.
create function ops.device_tender_types(p_token_hash text) returns jsonb
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
    'business_type', (select o.business_type from public.organisations o where o.id = d.org_id),
    'types', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'method', t.method, 'label', t.label,
                                          'sort', t.sort, 'archived', t.archived_at is not null)
                       order by t.sort, t.label)
      from public.tender_types t where t.org_id = d.org_id and t.location_id = d.location_id), '[]'::jsonb));
end
$$;
revoke all on function ops.device_tender_types(text) from public, anon, authenticated;
grant execute on function ops.device_tender_types(text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- public.tender_totals
-- Z-report groundwork: what was taken per payment type in a period, so the owner can compare the
-- card total with the shop terminal's end-of-day report. SECURITY INVOKER: RLS still applies.
-- Managers and owners only. `amount_cents` is what each type settled (cash net of change).
create function public.tender_totals(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (method text, label text, payments bigint, amount_cents bigint, tip_cents bigint)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'managers only' using errcode = '42501';
  end if;
  return query
  select p.method, coalesce(p.label, initcap(p.method)), count(*), sum(p.amount_cents)::bigint,
         sum(p.tip_cents)::bigint
  from public.payments p
  join public.sales s on s.org_id = p.org_id and s.id = p.sale_id
  where p.org_id = p_org and s.completed_at >= p_from and s.completed_at < p_to
  group by p.method, coalesce(p.label, initcap(p.method))
  order by p.method, 2;
end
$$;
revoke all on function public.tender_totals(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.tender_totals(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------- ops.record_sale (replaced)
-- Built on 0026's version (token check, every sum re-checked in SQL, review flags) and changed only
-- in how payments are read: a sale carries 1-10 payments (p -> 'payments'; the old single
-- p -> 'payment' still works). They must add up to amount_due, at most one is cash, tendered less
-- change is the amount, change only on cash, and each tender type belongs to this till's location
-- and matches its method. Any failure raises 22023, a rejection and never a retry.
create or replace function ops.record_sale(p jsonb, p_token_hash text default null) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jsonb := p -> 'sale';
  -- 1-10 payments; the old single p -> 'payment' still works for sales queued before tender types.
  v_pays jsonb := coalesce(p -> 'payments', jsonb_build_array(p -> 'payment'));
  v_org uuid := (s ->> 'org_id')::uuid;
  v_id uuid := (s ->> 'id')::uuid;
  v_reg uuid := (s ->> 'register_id')::uuid;
  v_user uuid := (s ->> 'user_id')::uuid;
  v_approver uuid := nullif(s ->> 'approved_by', '')::uuid;
  v_approval uuid := nullif(s ->> 'approval_id', '')::uuid;
  v_completed timestamptz := (s ->> 'completed_at')::timestamptz;
  v_items_total int := (s ->> 'items_total')::int;
  v_vat int := (s ->> 'vat')::int;
  v_non_vat int := (s ->> 'non_vat')::int;
  v_rounding int := (s ->> 'cash_rounding')::int;
  v_due int := (s ->> 'amount_due')::int;
  v_flags text[] := coalesce(array(select jsonb_array_elements_text(coalesce(s -> 'review_flags', '[]'::jsonb))), '{}');
  v_loc uuid;
  v_inserted int;
  v_existing public.sales%rowtype;
  v_sum_gross bigint;
  v_sum_vat bigint;
  v_sum_deposit bigint;
  v_bad_lines int;
  v_cash_n int;
  v_pay_sum bigint;
  v_bad_pays int;
  v_bad_cash int;
begin
  -- A till never names an approver: with a token, the approver comes only from a spent,
  -- PIN-verified register_approvals row below. approved_by is for the trusted back office alone.
  if p_token_hash is not null then
    v_approver := null;
  end if;
  if p_token_hash is not null and not exists (
       select 1 from app.device_register(p_token_hash) d
        where d.org_id = v_org and d.register_id = v_reg) then
    raise exception 'not this till' using errcode = '42501';
  end if;
  if not app.is_member(v_user, v_org) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select r.location_id into v_loc from public.registers r where r.id = v_reg and r.org_id = v_org;
  if v_loc is null then
    raise exception 'unknown register' using errcode = '42501';
  end if;

  -- The sums, from the lines up. Any difference means the record is wrong: refuse it (the sync
  -- route turns this into a rejection a manager sees, so it never blocks the till's queue).
  -- Each item line: VAT split exactly as src/lib/money splitVat does it (net = gross * 10000 /
  -- (10000 + rate), half away from zero, which is Postgres round(numeric)), and the discount is
  -- what the full price lost. Each deposit line: unit x qty. No other kind of line yet.
  select coalesce(sum((l ->> 'gross_cents')::bigint) filter (where l ->> 'kind' = 'item'), 0),
         coalesce(sum((l ->> 'vat_cents')::bigint) filter (where l ->> 'kind' = 'item'), 0),
         coalesce(sum((l ->> 'gross_cents')::bigint) filter (where l ->> 'kind' = 'deposit'), 0),
         count(*) filter (where
           case l ->> 'kind'
             when 'item' then
               num_nulls(l ->> 'gross_cents', l ->> 'net_cents', l ->> 'vat_cents', l ->> 'tax_rate_bp',
                         l ->> 'unit_price_cents', l ->> 'qty') > 0
               or (l ->> 'tax_rate_bp')::int not between 0 and 10000
               or (l ->> 'net_cents')::bigint
                  <> round((l ->> 'gross_cents')::numeric * 10000 / (10000 + (l ->> 'tax_rate_bp')::int))
               or (l ->> 'net_cents')::bigint + (l ->> 'vat_cents')::bigint <> (l ->> 'gross_cents')::bigint
               or coalesce((l ->> 'discount_cents')::bigint, 0) < 0
               or coalesce((l ->> 'discount_cents')::bigint, 0)
                  <> (l ->> 'unit_price_cents')::bigint * (l ->> 'qty')::bigint - (l ->> 'gross_cents')::bigint
             when 'deposit' then
               num_nulls(l ->> 'gross_cents', l ->> 'unit_price_cents', l ->> 'qty') > 0
               or (l ->> 'gross_cents')::bigint
                  <> (l ->> 'unit_price_cents')::bigint * (l ->> 'qty')::bigint
             else true
           end)
    into v_sum_gross, v_sum_vat, v_sum_deposit, v_bad_lines
    from jsonb_array_elements(p -> 'lines') l;
  -- The payments, shaped before they are summed. Cash settles its share plus rounding (what was
  -- handed over less the change); card and voucher settle exactly their amount, with no change.
  if jsonb_typeof(v_pays) <> 'array' or jsonb_array_length(v_pays) not between 1 and 10
     or exists (select 1 from jsonb_array_elements(v_pays) x
                where jsonb_typeof(x) <> 'object'
                   or coalesce(x ->> 'method', '') not in ('cash', 'card', 'voucher')
                   or num_nulls(x ->> 'amount', x ->> 'tendered') > 0) then
    raise exception 'payments are not valid' using errcode = '22023';
  end if;
  select count(*) filter (where x ->> 'method' = 'cash'),
         coalesce(sum((x ->> 'amount')::bigint), 0),
         count(*) filter (where (x ->> 'amount')::bigint < 0
                            or coalesce((x ->> 'change')::bigint, 0) < 0
                            or (x ->> 'tendered')::bigint - coalesce((x ->> 'change')::bigint, 0)
                               is distinct from (x ->> 'amount')::bigint
                            or (x ->> 'method' <> 'cash' and coalesce((x ->> 'change')::bigint, 0) <> 0)),
         -- When the cash share was rounded, the cash taken for it ends in 0 or 5.
         count(*) filter (where x ->> 'method' = 'cash' and v_rounding <> 0
                            and mod((x ->> 'amount')::bigint, 5) <> 0)
    into v_cash_n, v_pay_sum, v_bad_pays, v_bad_cash
    from jsonb_array_elements(v_pays) x;
  if exists (select 1 from jsonb_array_elements(v_pays) x
             where nullif(x ->> 'type_id', '') is not null
               and not exists (select 1 from public.tender_types tt
                               where tt.id = (x ->> 'type_id')::uuid and tt.org_id = v_org
                                 and tt.location_id = v_loc and tt.method = x ->> 'method')) then
    raise exception 'unknown payment type' using errcode = '22023';
  end if;

  if num_nulls(v_items_total, v_vat, v_non_vat, v_rounding, v_due) > 0
     or v_bad_lines > 0
     or v_sum_gross <> v_items_total or v_sum_vat <> v_vat or v_sum_deposit <> v_non_vat
     or v_due <> v_items_total + v_non_vat + v_rounding
     -- 5c cash rounding moves the cash share by at most 2c (and only where the shop rounds).
     or v_rounding not between -2 and 2
     or v_pay_sum <> v_due or v_cash_n > 1 or v_bad_pays > 0 or v_bad_cash > 0 then
    raise exception 'sale does not add up' using errcode = '22023';
  end if;
  -- The till's VAT is compared, never trusted; the flag must agree with it.
  if 'vat_differs' = any (v_flags) and (s ->> 'client_vat') is null then
    raise exception 'bad input' using errcode = '22023';
  end if;

  begin
    insert into public.sales (id, org_id, register_id, location_id, receipt_seq, mode, completed_at,
                              priced_as_of, cashier_user_id, items_total_cents, vat_cents, non_vat_cents,
                              cash_rounding_cents, amount_due_cents, client_due_cents,
                              client_vat_cents, review_flags)
    values (v_id, v_org, v_reg, v_loc, (s ->> 'receipt_seq')::int, s ->> 'mode', v_completed,
            (s ->> 'priced_as_of')::timestamptz, v_user, v_items_total, v_vat, v_non_vat,
            v_rounding, v_due, (s ->> 'client_due')::int,
            nullif(s ->> 'client_vat', '')::int, v_flags)
    on conflict (id) do nothing;
    get diagnostics v_inserted = row_count;
  exception when unique_violation then
    return 'receipt_clash';
  end;

  if v_inserted = 0 then
    select * into v_existing from public.sales where id = v_id;
    if v_existing.org_id = v_org and v_existing.register_id = v_reg then
      return 'duplicate';
    end if;
    raise exception 'sale id in use' using errcode = '23505';
  end if;

  if v_approval is not null then
    v_approver := null;
    select a.approver_user_id into v_approver
      from public.register_approvals a
     where a.id = v_approval and a.org_id = v_org and a.register_id = v_reg
       and a.purpose = 'discount' and a.consumed_at is null
       and v_completed between a.created_at - interval '1 minute' and a.created_at + interval '30 minutes'
     for update;
    if v_approver is null then
      raise exception 'approval not valid' using errcode = '42501';
    end if;
    update public.register_approvals set consumed_at = now(), consumed_for = v_id where id = v_approval;
  end if;
  if v_approver is not null and not app.is_manager(v_approver, v_org) then
    raise exception 'approver is not a manager' using errcode = '42501';
  end if;

  insert into public.sale_lines (id, org_id, sale_id, line_no, kind, variant_id, product_id, name, qty,
                                 unit_price_cents, modifiers, serial, discount_cents, tax_category,
                                 tax_rate_bp, net_cents, vat_cents, gross_cents)
  select gen_random_uuid(), v_org, v_id, l.ord::int, l.value ->> 'kind',
         (l.value ->> 'variant_id')::uuid, (l.value ->> 'product_id')::uuid, l.value ->> 'name',
         (l.value ->> 'qty')::int, (l.value ->> 'unit_price_cents')::int,
         coalesce(l.value -> 'modifiers', '[]'::jsonb), nullif(l.value ->> 'serial', ''),
         coalesce((l.value ->> 'discount_cents')::int, 0), l.value ->> 'tax_category',
         (l.value ->> 'tax_rate_bp')::int, (l.value ->> 'net_cents')::int,
         (l.value ->> 'vat_cents')::int, (l.value ->> 'gross_cents')::int
  from jsonb_array_elements(p -> 'lines') with ordinality as l(value, ord);

  insert into public.payments (id, org_id, sale_id, tender_type_id, label, method, amount_cents,
                               tendered_cents, change_cents, tip_cents, provider_ref)
  select gen_random_uuid(), v_org, v_id, nullif(x ->> 'type_id', '')::uuid,
         coalesce((select tt.label from public.tender_types tt
                   where tt.org_id = v_org and tt.id = nullif(x ->> 'type_id', '')::uuid),
                  initcap(x ->> 'method')),
         x ->> 'method', (x ->> 'amount')::int, (x ->> 'tendered')::int,
         coalesce((x ->> 'change')::int, 0), coalesce((x ->> 'tip')::int, 0),
         nullif(x ->> 'reference', '')
  from jsonb_array_elements(v_pays) x;

  insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, ref_id, actor_user_id)
  select gen_random_uuid(), v_org, l.variant_id, v_loc, -sum(l.qty)::int, 'sale', v_id, v_user
  from public.sale_lines l
  join public.products p on p.org_id = l.org_id and p.id = l.product_id
  where l.sale_id = v_id and l.kind = 'item' and l.variant_id is not null and p.track_stock
  group by l.variant_id;

  if v_approver is not null then
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (gen_random_uuid(), v_org, v_user, 'sale.discount_override', 'sale', v_id,
            jsonb_build_object('approved_by', v_approver, 'register_id', v_reg,
                               'approval', case when v_approval is not null then 'pin_verified'
                                                else 'manager_session' end,
                               'discount_cents', (select coalesce(sum(l.discount_cents), 0)
                                                  from public.sale_lines l where l.sale_id = v_id)));
  end if;

  update public.registers set last_seen_at = now() where id = v_reg and org_id = v_org;
  return 'created';
end
$$;

