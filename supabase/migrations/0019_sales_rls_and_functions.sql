-- Hand-written: RLS, append-only triggers, price history and the sync functions (step 1.6).
--
-- Sales, lines and payments are written ONLY by ops.record_sale, after the route re-priced the sale
-- with src/lib/money. Clients (anon/authenticated) get SELECT and nothing else, so nobody can forge a
-- total through the API. Triggers also refuse UPDATE/DELETE/TRUNCATE for every role.

-- ---------------------------------------------------------------- append-only guard
create function app.forbid_change() returns trigger
language plpgsql set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end
$$;

-- ---------------------------------------------------------------- sales, sale_lines, payments
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.payments enable row level security;
revoke all on public.sales, public.sale_lines, public.payments from anon, authenticated;
grant select on public.sales, public.sale_lines, public.payments to authenticated;

create policy sales_select on public.sales for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy sale_lines_select on public.sale_lines for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy payments_select on public.payments for select to authenticated
  using (org_id in (select app.current_org_ids()));

create trigger sales_append_only before update or delete on public.sales
  for each row execute function app.forbid_change();
create trigger sale_lines_append_only before update or delete on public.sale_lines
  for each row execute function app.forbid_change();
create trigger payments_append_only before update or delete on public.payments
  for each row execute function app.forbid_change();
create trigger sales_no_truncate before truncate on public.sales
  for each statement execute function app.forbid_change();
create trigger sale_lines_no_truncate before truncate on public.sale_lines
  for each statement execute function app.forbid_change();
create trigger payments_no_truncate before truncate on public.payments
  for each statement execute function app.forbid_change();

-- ---------------------------------------------------------------- sync_rejections (managers)
alter table public.sync_rejections enable row level security;
revoke all on public.sync_rejections from anon, authenticated;
grant select on public.sync_rejections to authenticated;
create policy sync_rejections_select on public.sync_rejections for select to authenticated
  using (org_id in (select app.manager_org_ids()));

-- ---------------------------------------------------------------- price history
alter table public.variant_price_history enable row level security;
alter table public.modifier_price_history enable row level security;
revoke all on public.variant_price_history, public.modifier_price_history from anon, authenticated;
grant select on public.variant_price_history, public.modifier_price_history to authenticated;
create policy variant_price_history_select on public.variant_price_history for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy modifier_price_history_select on public.modifier_price_history for select to authenticated
  using (org_id in (select app.current_org_ids()));

create trigger variant_price_history_append_only before update or delete on public.variant_price_history
  for each row execute function app.forbid_change();
create trigger modifier_price_history_append_only before update or delete on public.modifier_price_history
  for each row execute function app.forbid_change();

-- Backfill: what exists now has been in force "forever".
insert into public.variant_price_history
  (org_id, variant_id, product_id, price_incl_vat_cents, deposit_cents, tax_category, takeaway_tax_category, valid_from)
select v.org_id, v.id, v.product_id, v.price_incl_vat_cents,
       coalesce(nullif(v.attributes ->> 'depositCents', '')::int, 0),
       p.tax_category, p.takeaway_tax_category, '-infinity'
from public.variants v join public.products p on p.org_id = v.org_id and p.id = v.product_id;

insert into public.modifier_price_history (org_id, modifier_id, group_id, name, price_delta_cents, valid_from)
select org_id, id, group_id, name, price_delta_cents, '-infinity' from public.modifiers;

-- clock_timestamp() (not now()) so two rows written in one transaction still order correctly.
create function app.record_variant_price() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_deposit int := coalesce(nullif(new.attributes ->> 'depositCents', '')::int, 0);
  p public.products%rowtype;
begin
  if tg_op = 'UPDATE'
     and old.price_incl_vat_cents = new.price_incl_vat_cents
     and coalesce(nullif(old.attributes ->> 'depositCents', '')::int, 0) = v_deposit then
    return new;
  end if;
  select * into p from public.products where org_id = new.org_id and id = new.product_id;
  insert into public.variant_price_history
    (org_id, variant_id, product_id, price_incl_vat_cents, deposit_cents, tax_category, takeaway_tax_category, valid_from)
  values (new.org_id, new.id, new.product_id, new.price_incl_vat_cents, v_deposit,
          p.tax_category, p.takeaway_tax_category, clock_timestamp());
  return new;
end
$$;
revoke all on function app.record_variant_price() from public, anon, authenticated;

create trigger variants_price_history after insert or update of price_incl_vat_cents, attributes
  on public.variants for each row execute function app.record_variant_price();

create function app.record_product_tax() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.tax_category = new.tax_category
     and old.takeaway_tax_category is not distinct from new.takeaway_tax_category then
    return new;
  end if;
  insert into public.variant_price_history
    (org_id, variant_id, product_id, price_incl_vat_cents, deposit_cents, tax_category, takeaway_tax_category, valid_from)
  select v.org_id, v.id, v.product_id, v.price_incl_vat_cents,
         coalesce(nullif(v.attributes ->> 'depositCents', '')::int, 0),
         new.tax_category, new.takeaway_tax_category, clock_timestamp()
  from public.variants v where v.org_id = new.org_id and v.product_id = new.id;
  return new;
end
$$;
revoke all on function app.record_product_tax() from public, anon, authenticated;

create trigger products_tax_history after update of tax_category, takeaway_tax_category
  on public.products for each row execute function app.record_product_tax();

create function app.record_modifier_price() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.price_delta_cents = new.price_delta_cents and old.name = new.name then
    return new;
  end if;
  insert into public.modifier_price_history (org_id, modifier_id, group_id, name, price_delta_cents, valid_from)
  values (new.org_id, new.id, new.group_id, new.name, new.price_delta_cents, clock_timestamp());
  return new;
end
$$;
revoke all on function app.record_modifier_price() from public, anon, authenticated;

create trigger modifiers_price_history after insert or update of price_delta_cents, name
  on public.modifiers for each row execute function app.record_modifier_price();

-- ---------------------------------------------------------------- catalogue as of a moment
-- SECURITY INVOKER: RLS applies, so another shop's ids simply come back empty.
-- Prices, VAT categories, deposits and modifier deltas are those in force at p_at; names and
-- attributes (size, warranty, ...) are current. Products/variants created after p_at are absent.
create function public.sale_catalog_as_of(
  p_org uuid, p_variant_ids uuid[], p_modifier_ids uuid[], p_at timestamptz
) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  with vh as (
    select distinct on (h.variant_id) h.*
    from public.variant_price_history h
    where h.org_id = p_org and h.variant_id = any (p_variant_ids) and h.valid_from <= p_at
    order by h.variant_id, h.valid_from desc
  ), mh as (
    select distinct on (h.modifier_id) h.*
    from public.modifier_price_history h
    where h.org_id = p_org and h.modifier_id = any (p_modifier_ids) and h.valid_from <= p_at
    order by h.modifier_id, h.valid_from desc
  )
  select jsonb_build_object(
    'variants', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'product_id', v.product_id, 'name', v.name,
        'price_cents', vh.price_incl_vat_cents,
        'tax_category', vh.tax_category, 'takeaway_tax_category', vh.takeaway_tax_category,
        'attributes', v.attributes || jsonb_build_object('depositCents', vh.deposit_cents)))
      from vh join public.variants v on v.org_id = p_org and v.id = vh.variant_id), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'track_stock', p.track_stock))
      from public.products p
      where p.org_id = p_org and p.id in (select product_id from vh)), '[]'::jsonb),
    'modifiers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', mh.modifier_id, 'group_id', mh.group_id, 'name', mh.name,
        'price_delta_cents', mh.price_delta_cents))
      from mh), '[]'::jsonb),
    'product_groups', coalesce((
      select jsonb_agg(jsonb_build_object('product_id', g.product_id, 'group_id', g.group_id))
      from public.product_modifier_groups g
      where g.org_id = p_org and g.product_id in (select product_id from vh)), '[]'::jsonb)
  )
$$;
revoke all on function public.sale_catalog_as_of(uuid, uuid[], uuid[], timestamptz) from public, anon;
grant execute on function public.sale_catalog_as_of(uuid, uuid[], uuid[], timestamptz) to authenticated;

-- The highest receipt number each till has on the server, so a device whose browser data was
-- cleared carries on after it instead of repeating numbers. SECURITY INVOKER (RLS applies).
create function public.register_last_seqs(p_org uuid)
returns table (register_id uuid, last_seq integer)
language sql stable security invoker set search_path = ''
as $$
  select s.register_id, max(s.receipt_seq)::integer
  from public.sales s where s.org_id = p_org group by s.register_id
$$;
revoke all on function public.register_last_seqs(uuid) from public, anon;
grant execute on function public.register_last_seqs(uuid) to authenticated;

-- ---------------------------------------------------------------- ops.record_sale
-- p: {sale:{id, org_id, register_id, user_id, receipt_seq, mode, completed_at, priced_as_of,
--           items_total, vat, non_vat, cash_rounding, amount_due, client_due},
--     lines:[{kind, variant_id, product_id, name, qty, unit_price_cents, modifiers, serial,
--             discount_cents, tax_category, tax_rate_bp, net_cents, vat_cents, gross_cents}],
--     payment:{method, amount, tendered, change}}
-- Returns 'created' | 'duplicate' | 'receipt_clash'. The caller (the sync route) has already
-- authenticated the user and re-priced the sale; this function re-checks that the user is a member
-- of the org and the register belongs to it, then writes everything in one transaction.
create function ops.record_sale(p jsonb) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jsonb := p -> 'sale';
  v_org uuid := (s ->> 'org_id')::uuid;
  v_id uuid := (s ->> 'id')::uuid;
  v_reg uuid := (s ->> 'register_id')::uuid;
  v_user uuid := (s ->> 'user_id')::uuid;
  v_loc uuid;
  v_inserted int;
  v_existing public.sales%rowtype;
begin
  if not exists (select 1 from public.memberships m where m.org_id = v_org and m.user_id = v_user) then
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

  insert into public.payments (id, org_id, sale_id, method, amount_cents, tendered_cents, change_cents)
  values (gen_random_uuid(), v_org, v_id, coalesce(p -> 'payment' ->> 'method', 'cash'),
          (p -> 'payment' ->> 'amount')::int, (p -> 'payment' ->> 'tendered')::int,
          (p -> 'payment' ->> 'change')::int);

  -- One ledger row per tracked variant. Negative stock is allowed (reported, not blocked).
  insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, ref_id, actor_user_id)
  select gen_random_uuid(), v_org, l.variant_id, v_loc, -sum(l.qty)::int, 'sale', v_id, v_user
  from public.sale_lines l
  join public.products p on p.org_id = l.org_id and p.id = l.product_id
  where l.sale_id = v_id and l.kind = 'item' and l.variant_id is not null and p.track_stock
  group by l.variant_id;

  update public.registers set last_seen_at = now() where id = v_reg and org_id = v_org;
  return 'created';
end
$$;

-- ---------------------------------------------------------------- ops.record_sync_rejection
-- p: {id, org_id, register_id, user_id, reason, detail, payload}. Idempotent; never overwrites a
-- recorded sale. Writes an audit row.
create function ops.record_sync_rejection(p jsonb) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_id uuid := (p ->> 'id')::uuid;
  v_reg uuid := (p ->> 'register_id')::uuid;
  v_user uuid := (p ->> 'user_id')::uuid;
  v_inserted int;
begin
  if not exists (select 1 from public.memberships m where m.org_id = v_org and m.user_id = v_user) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  if not exists (select 1 from public.registers r where r.id = v_reg and r.org_id = v_org) then
    raise exception 'unknown register' using errcode = '42501';
  end if;
  if exists (select 1 from public.sales where id = v_id) then
    return;
  end if;

  insert into public.sync_rejections (id, org_id, register_id, reason, detail, payload)
  values (v_id, v_org, v_reg, p ->> 'reason', coalesce(p -> 'detail', '{}'::jsonb), p -> 'payload')
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (gen_random_uuid(), v_org, v_user, 'sale.sync_rejected', 'sale', v_id,
            jsonb_build_object('reason', p ->> 'reason', 'register_id', v_reg));
  end if;
end
$$;

-- ---------------------------------------------------------------- ops.touch_register
create function ops.touch_register(p_org uuid, p_register uuid, p_user uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.memberships m where m.org_id = p_org and m.user_id = p_user) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  update public.registers set last_seen_at = now() where id = p_register and org_id = p_org;
end
$$;

revoke all on function ops.record_sale(jsonb) from public, anon, authenticated;
revoke all on function ops.record_sync_rejection(jsonb) from public, anon, authenticated;
revoke all on function ops.touch_register(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function ops.record_sale(jsonb) to service_role, tillflow_ops;
grant execute on function ops.record_sync_rejection(jsonb) to service_role, tillflow_ops;
grant execute on function ops.touch_register(uuid, uuid, uuid) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- resolve_sync_rejection
-- A manager (aal2 for owners, like every manager policy) closes an item on "Needs attention".
create function public.resolve_sync_rejection(p_id uuid, p_note text, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_org uuid;
begin
  select org_id into v_org from public.sync_rejections where id = p_id;
  if v_user is null or v_org is null
     or not exists (select 1 from app.manager_org_ids() o where o = v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_note is null or char_length(btrim(p_note)) not between 1 and 500 then
    raise exception 'a note is required' using errcode = '22023';
  end if;

  update public.sync_rejections
     set status = 'resolved', resolved_by = v_user, resolved_at = now(), note = btrim(p_note)
   where id = p_id and status = 'open';

  if found then
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (p_audit_id, v_org, v_user, 'sale.sync_rejection_resolved', 'sale', p_id,
            jsonb_build_object('note', btrim(p_note)));
  end if;
end
$$;
revoke all on function public.resolve_sync_rejection(uuid, text, uuid) from public, anon;
grant execute on function public.resolve_sync_rejection(uuid, text, uuid) to authenticated;
