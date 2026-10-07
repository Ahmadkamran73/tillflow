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
-- As in 0023, but a sale carries 1-10 payments (p -> 'payments'; the old single p -> 'payment' still
-- works for sales queued before tender types). The payments must add up to the amount due, at most
-- one is cash, and each tender type must belong to this till's location and match its method.
create or replace function ops.record_sale(p jsonb) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jsonb := p -> 'sale';
  v_org uuid := (s ->> 'org_id')::uuid;
  v_id uuid := (s ->> 'id')::uuid;
  v_reg uuid := (s ->> 'register_id')::uuid;
  v_user uuid := (s ->> 'user_id')::uuid;
  -- approved_by is for TRUSTED callers only (the back office re-running a held sale as a manager).
  -- A till never supplies it: it supplies approval_id, and the approver is derived from that.
  v_approver uuid := nullif(s ->> 'approved_by', '')::uuid;
  v_approval uuid := nullif(s ->> 'approval_id', '')::uuid;
  v_completed timestamptz := (s ->> 'completed_at')::timestamptz;
  v_pays jsonb := coalesce(p -> 'payments', jsonb_build_array(p -> 'payment'));
  v_loc uuid;
  v_inserted int;
  v_existing public.sales%rowtype;
begin
  if not app.is_member(v_user, v_org) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select r.location_id into v_loc from public.registers r where r.id = v_reg and r.org_id = v_org;
  if v_loc is null then
    raise exception 'unknown register' using errcode = '42501';
  end if;

  begin
    insert into public.sales (id, org_id, register_id, location_id, receipt_seq, mode, completed_at,
                              priced_as_of, cashier_user_id, items_total_cents, vat_cents, non_vat_cents,
                              cash_rounding_cents, amount_due_cents, client_due_cents)
    values (v_id, v_org, v_reg, v_loc, (s ->> 'receipt_seq')::int, s ->> 'mode',
            (s ->> 'completed_at')::timestamptz, (s ->> 'priced_as_of')::timestamptz, v_user,
            (s ->> 'items_total')::int, (s ->> 'vat')::int, (s ->> 'non_vat')::int,
            (s ->> 'cash_rounding')::int, (s ->> 'amount_due')::int, (s ->> 'client_due')::int)
    on conflict (id) do nothing;
    get diagnostics v_inserted = row_count;
  exception when unique_violation then
    return 'receipt_clash';
  end;

  if v_inserted = 0 then
    select * into v_existing from public.sales where id = v_id;
    -- A sale id that belongs to another shop is never reported as ours.
    if v_existing.org_id = v_org and v_existing.register_id = v_reg then
      return 'duplicate';
    end if;
    raise exception 'sale id in use' using errcode = '23505';
  end if;

  -- A till's approval: single use, this register, purpose discount, spent within 30 minutes of the
  -- PIN check (by the sale's own time, so a sale made online-then-queued still counts).
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

  -- Payments: re-checked here because this function is the last line of defence. Any failure
  -- raises 22023, which the route turns into a rejection a manager sees (and rolls the sale back).
  if jsonb_typeof(v_pays) <> 'array' or jsonb_array_length(v_pays) not between 1 and 10 then
    raise exception 'payments must be 1 to 10' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(v_pays) x where x ->> 'method' = 'cash') > 1 then
    raise exception 'more than one cash payment' using errcode = '22023';
  end if;
  if (select coalesce(sum((x ->> 'amount')::int), 0) from jsonb_array_elements(v_pays) x)
       <> (s ->> 'amount_due')::int then
    raise exception 'payments do not add up to the amount due' using errcode = '22023';
  end if;
  -- What was handed over less the change is what the payment settles.
  if exists (select 1 from jsonb_array_elements(v_pays) x
             where (x ->> 'tendered')::int - coalesce((x ->> 'change')::int, 0) is distinct from (x ->> 'amount')::int) then
    raise exception 'tendered less change is not the amount' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_pays) x
             where nullif(x ->> 'type_id', '') is not null
               and not exists (select 1 from public.tender_types tt
                               where tt.id = (x ->> 'type_id')::uuid and tt.org_id = v_org
                                 and tt.location_id = v_loc and tt.method = x ->> 'method')) then
    raise exception 'unknown payment type' using errcode = '22023';
  end if;

  insert into public.payments (id, org_id, sale_id, tender_type_id, label, method, amount_cents,
                               tendered_cents, change_cents, tip_cents, provider_ref)
  select gen_random_uuid(), v_org, v_id, nullif(x ->> 'type_id', '')::uuid,
         coalesce((select tt.label from public.tender_types tt
                   where tt.org_id = v_org and tt.id = nullif(x ->> 'type_id', '')::uuid), initcap(x ->> 'method')),
         coalesce(x ->> 'method', 'cash'), (x ->> 'amount')::int, (x ->> 'tendered')::int,
         coalesce((x ->> 'change')::int, 0), coalesce((x ->> 'tip')::int, 0),
         nullif(x ->> 'reference', '')
  from jsonb_array_elements(v_pays) x;

  -- One ledger row per tracked variant. Negative stock is allowed (reported, not blocked).
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


revoke all on function ops.record_sale(jsonb) from public, anon, authenticated;
grant execute on function ops.record_sale(jsonb) to service_role, tillflow_ops;
