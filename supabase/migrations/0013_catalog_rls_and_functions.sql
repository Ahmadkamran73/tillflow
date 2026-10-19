-- Hand-written: RLS for the catalogue tables, stock trigger, and the two save functions.
-- Reads: any member. Writes: owner/manager. Products and variants are archived, never deleted.
-- stock_levels is written only by the stock_movements trigger; stock_movements is append-only.

-- ---------------------------------------------------------------- products
alter table public.products enable row level security;
revoke all on public.products from anon, authenticated;
grant select on public.products to authenticated;
grant insert (id, org_id, name, category_id, tax_category, takeaway_tax_category, track_stock)
  on public.products to authenticated;
grant update (name, category_id, tax_category, takeaway_tax_category, track_stock, archived_at)
  on public.products to authenticated;

create policy products_select on public.products for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy products_insert on public.products for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy products_update on public.products for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));

create trigger products_touch before update on public.products
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- variants
alter table public.variants add constraint variants_attributes_object
  check (jsonb_typeof(attributes) = 'object');

-- save_product is callable directly by managers, so the DB repeats the money-relevant attribute rules.
alter table public.variants add constraint variants_deposit_cents
  check (not (attributes ? 'depositCents')
         or (jsonb_typeof(attributes -> 'depositCents') = 'number'
             and (attributes ->> 'depositCents') ~ '^[0-9]{1,5}$'
             and (attributes ->> 'depositCents')::int <= 10000));

alter table public.variants enable row level security;
revoke all on public.variants from anon, authenticated;
grant select on public.variants to authenticated;
grant insert (id, org_id, product_id, name, sku, barcode, price_incl_vat_cents, cost_cents, attributes, sort)
  on public.variants to authenticated;
grant update (name, sku, barcode, price_incl_vat_cents, cost_cents, attributes, sort, archived_at)
  on public.variants to authenticated;

create policy variants_select on public.variants for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy variants_insert on public.variants for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy variants_update on public.variants for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));

create trigger variants_touch before update on public.variants
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- stock_levels (read-only for clients)
alter table public.stock_levels enable row level security;
revoke all on public.stock_levels from anon, authenticated;
grant select on public.stock_levels to authenticated;

create policy stock_levels_select on public.stock_levels for select to authenticated
  using (org_id in (select app.current_org_ids()));

-- ---------------------------------------------------------------- stock_movements (append-only)
alter table public.stock_movements enable row level security;
revoke all on public.stock_movements from anon, authenticated;
grant select on public.stock_movements to authenticated;
grant insert (id, org_id, variant_id, location_id, qty_delta, reason, actor_user_id)
  on public.stock_movements to authenticated;

create policy stock_movements_select on public.stock_movements for select to authenticated
  using (org_id in (select app.current_org_ids()));
-- Clients may only record opening stock and manual adjustments, as themselves. Sales and refunds
-- come from the sync route.
create policy stock_movements_insert on public.stock_movements for insert to authenticated
  with check (
    org_id in (select app.manager_org_ids())
    and reason in ('opening', 'adjustment')
    and actor_user_id = (select app.current_user_id())
  );

create function app.apply_stock_movement()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.stock_levels (id, org_id, variant_id, location_id, on_hand)
  values (gen_random_uuid(), new.org_id, new.variant_id, new.location_id, new.qty_delta)
  on conflict (org_id, variant_id, location_id)
  do update set on_hand = public.stock_levels.on_hand + excluded.on_hand, updated_at = now();
  return new;
end
$$;
revoke all on function app.apply_stock_movement() from public, anon, authenticated;

create trigger stock_movements_apply after insert on public.stock_movements
  for each row execute function app.apply_stock_movement();

-- ---------------------------------------------------------------- modifier_groups
alter table public.modifier_groups enable row level security;
revoke all on public.modifier_groups from anon, authenticated;
grant select on public.modifier_groups to authenticated;
grant insert (id, org_id, name, min_choices, max_choices, sort) on public.modifier_groups to authenticated;
grant update (name, min_choices, max_choices, sort) on public.modifier_groups to authenticated;
grant delete on public.modifier_groups to authenticated;

create policy modifier_groups_select on public.modifier_groups for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy modifier_groups_insert on public.modifier_groups for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy modifier_groups_update on public.modifier_groups for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));
create policy modifier_groups_delete on public.modifier_groups for delete to authenticated
  using (org_id in (select app.owner_org_ids()));

create trigger modifier_groups_touch before update on public.modifier_groups
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- modifiers
alter table public.modifiers enable row level security;
revoke all on public.modifiers from anon, authenticated;
grant select on public.modifiers to authenticated;
grant insert (id, org_id, group_id, name, price_delta_cents, sort) on public.modifiers to authenticated;
grant update (name, price_delta_cents, sort) on public.modifiers to authenticated;
grant delete on public.modifiers to authenticated;

create policy modifiers_select on public.modifiers for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy modifiers_insert on public.modifiers for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy modifiers_update on public.modifiers for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));
create policy modifiers_delete on public.modifiers for delete to authenticated
  using (org_id in (select app.manager_org_ids()));

create trigger modifiers_touch before update on public.modifiers
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- product_modifier_groups
alter table public.product_modifier_groups enable row level security;
revoke all on public.product_modifier_groups from anon, authenticated;
grant select on public.product_modifier_groups to authenticated;
grant insert (id, org_id, product_id, group_id, sort) on public.product_modifier_groups to authenticated;
grant delete on public.product_modifier_groups to authenticated;

create policy product_modifier_groups_select on public.product_modifier_groups for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy product_modifier_groups_insert on public.product_modifier_groups for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy product_modifier_groups_delete on public.product_modifier_groups for delete to authenticated
  using (org_id in (select app.manager_org_ids()));

-- ---------------------------------------------------------------- save_product
-- SECURITY INVOKER: every statement runs under the caller's RLS, so a cashier or another org's
-- user fails on the first write. One call = one transaction (supabase-js has none).
-- p: {org_id, location_id, product:{id,name,category_id,tax_category,takeaway_tax_category,track_stock},
--     variants:[{id,name,sku,barcode,price_incl_vat_cents,cost_cents,attributes,sort,opening_stock}],
--     modifier_group_ids:[uuid]}
-- Variants of the product that are not listed are archived (their barcode and SKU are released).
-- opening_stock is recorded only for a variant created by this call.
create function public.save_product(p jsonb)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_loc uuid := (p ->> 'location_id')::uuid;
  v_pid uuid := (p -> 'product' ->> 'id')::uuid;
  v_user uuid := (select app.current_user_id());
  v_track boolean := coalesce((p -> 'product' ->> 'track_stock')::boolean, true);
  v jsonb;
  v_inserted boolean;
  v_qty int;
begin
  if jsonb_typeof(p -> 'variants') is distinct from 'array' or jsonb_array_length(p -> 'variants') not between 1 and 200 then
    raise exception 'a product needs between 1 and 200 variants' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p -> 'modifier_group_ids', '[]'::jsonb)) > 20 then
    raise exception 'too many modifier groups' using errcode = '22023';
  end if;

  insert into public.products (id, org_id, name, category_id, tax_category, takeaway_tax_category, track_stock)
  values (v_pid, v_org, p -> 'product' ->> 'name', (p -> 'product' ->> 'category_id')::uuid,
          p -> 'product' ->> 'tax_category', p -> 'product' ->> 'takeaway_tax_category', v_track)
  on conflict (id) do update
    set name = excluded.name, category_id = excluded.category_id, tax_category = excluded.tax_category,
        takeaway_tax_category = excluded.takeaway_tax_category, track_stock = excluded.track_stock,
        archived_at = null;

  for v in select value from jsonb_array_elements(p -> 'variants') loop
    insert into public.variants (id, org_id, product_id, name, sku, barcode, price_incl_vat_cents,
                                 cost_cents, attributes, sort)
    values ((v ->> 'id')::uuid, v_org, v_pid, coalesce(v ->> 'name', ''), nullif(v ->> 'sku', ''),
            nullif(v ->> 'barcode', ''), (v ->> 'price_incl_vat_cents')::int,
            (v ->> 'cost_cents')::int, coalesce(v -> 'attributes', '{}'::jsonb),
            coalesce((v ->> 'sort')::int, 0))
    on conflict (id) do update
      set name = excluded.name, sku = excluded.sku, barcode = excluded.barcode,
          price_incl_vat_cents = excluded.price_incl_vat_cents, cost_cents = excluded.cost_cents,
          attributes = excluded.attributes, sort = excluded.sort, archived_at = null
      where public.variants.product_id = excluded.product_id
    returning (xmax = 0) into v_inserted;
    if not found then
      raise exception 'variant belongs to another product' using errcode = '42501';
    end if;

    v_qty := coalesce((v ->> 'opening_stock')::int, 0);
    if v_inserted and v_track and v_qty <> 0 then
      insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, actor_user_id)
      values (gen_random_uuid(), v_org, (v ->> 'id')::uuid, v_loc, v_qty, 'opening', v_user);
    end if;
  end loop;

  update public.variants
     set archived_at = now(), sku = null, barcode = null
   where org_id = v_org and product_id = v_pid and archived_at is null
     and id <> all (select (x ->> 'id')::uuid from jsonb_array_elements(p -> 'variants') x);

  delete from public.product_modifier_groups
   where org_id = v_org and product_id = v_pid
     and group_id <> all (select g::uuid from jsonb_array_elements_text(coalesce(p -> 'modifier_group_ids', '[]'::jsonb)) g);
  insert into public.product_modifier_groups (id, org_id, product_id, group_id, sort)
  select gen_random_uuid(), v_org, v_pid, g.id::uuid, g.ord::int
  from jsonb_array_elements_text(coalesce(p -> 'modifier_group_ids', '[]'::jsonb)) with ordinality as g(id, ord)
  on conflict (org_id, product_id, group_id) do nothing;
end
$$;

revoke all on function public.save_product(jsonb) from public, anon;
grant execute on function public.save_product(jsonb) to authenticated;

-- ---------------------------------------------------------------- save_modifier_group
-- p: {org_id, group:{id,name,min_choices,max_choices}, options:[{id,name,price_delta_cents}]}
-- Options not listed are deleted (sales keep their own snapshot).
create function public.save_modifier_group(p jsonb)
returns void
language plpgsql security invoker set search_path = ''
as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_gid uuid := (p -> 'group' ->> 'id')::uuid;
begin
  if jsonb_typeof(p -> 'options') is distinct from 'array' or jsonb_array_length(p -> 'options') not between 1 and 50 then
    raise exception 'a group needs between 1 and 50 options' using errcode = '22023';
  end if;

  insert into public.modifier_groups (id, org_id, name, min_choices, max_choices)
  values (v_gid, v_org, p -> 'group' ->> 'name', (p -> 'group' ->> 'min_choices')::int,
          (p -> 'group' ->> 'max_choices')::int)
  on conflict (id) do update
    set name = excluded.name, min_choices = excluded.min_choices, max_choices = excluded.max_choices;

  delete from public.modifiers
   where org_id = v_org and group_id = v_gid
     and id <> all (select (o ->> 'id')::uuid from jsonb_array_elements(p -> 'options') o);

  insert into public.modifiers (id, org_id, group_id, name, price_delta_cents, sort)
  select (o.value ->> 'id')::uuid, v_org, v_gid, o.value ->> 'name',
         coalesce((o.value ->> 'price_delta_cents')::int, 0), o.ord::int
  from jsonb_array_elements(p -> 'options') with ordinality as o(value, ord)
  on conflict (id) do update
    set name = excluded.name, price_delta_cents = excluded.price_delta_cents, sort = excluded.sort
    where public.modifiers.group_id = excluded.group_id;
end
$$;

revoke all on function public.save_modifier_group(jsonb) from public, anon;
grant execute on function public.save_modifier_group(jsonb) to authenticated;