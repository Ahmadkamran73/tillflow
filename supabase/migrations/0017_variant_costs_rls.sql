-- Cost prices were readable by cashiers straight through the API (variants.cost_cents sat in a
-- table every member can select). They now live in variant_costs, which only managers and owners
-- can read or write (0016 created the table and moved the data). save_product writes it.

alter table public.variant_costs enable row level security;
revoke all on public.variant_costs from anon, authenticated;
grant select, delete on public.variant_costs to authenticated;
grant insert (variant_id, org_id, cost_cents) on public.variant_costs to authenticated;
grant update (cost_cents) on public.variant_costs to authenticated;

create policy variant_costs_select on public.variant_costs for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy variant_costs_insert on public.variant_costs for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy variant_costs_update on public.variant_costs for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));
create policy variant_costs_delete on public.variant_costs for delete to authenticated
  using (org_id in (select app.manager_org_ids()));

create trigger variant_costs_touch before update on public.variant_costs
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- save_product (cost moved)
-- Same contract as 0013; only the cost handling changed.
create or replace function public.save_product(p jsonb)
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
                                 attributes, sort)
    values ((v ->> 'id')::uuid, v_org, v_pid, coalesce(v ->> 'name', ''), nullif(v ->> 'sku', ''),
            nullif(v ->> 'barcode', ''), (v ->> 'price_incl_vat_cents')::int,
            coalesce(v -> 'attributes', '{}'::jsonb),
            coalesce((v ->> 'sort')::int, 0))
    on conflict (id) do update
      set name = excluded.name, sku = excluded.sku, barcode = excluded.barcode,
          price_incl_vat_cents = excluded.price_incl_vat_cents,
          attributes = excluded.attributes, sort = excluded.sort, archived_at = null
      where public.variants.product_id = excluded.product_id
    returning (xmax = 0) into v_inserted;
    if not found then
      raise exception 'variant belongs to another product' using errcode = '42501';
    end if;

    -- Cost lives in variant_costs (managers and owners only); no cost means no row.
    if nullif(v ->> 'cost_cents', '') is null then
      delete from public.variant_costs where org_id = v_org and variant_id = (v ->> 'id')::uuid;
    else
      insert into public.variant_costs (variant_id, org_id, cost_cents)
      values ((v ->> 'id')::uuid, v_org, (v ->> 'cost_cents')::int)
      on conflict (variant_id) do update set cost_cents = excluded.cost_cents
        where public.variant_costs.org_id = excluded.org_id;
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

  -- An archived variant no longer carries a cost.
  delete from public.variant_costs
   where org_id = v_org
     and variant_id in (select id from public.variants where org_id = v_org and product_id = v_pid and archived_at is not null);

  delete from public.product_modifier_groups
   where org_id = v_org and product_id = v_pid
     and group_id <> all (select g::uuid from jsonb_array_elements_text(coalesce(p -> 'modifier_group_ids', '[]'::jsonb)) g);
  insert into public.product_modifier_groups (id, org_id, product_id, group_id, sort)
  select gen_random_uuid(), v_org, v_pid, g.id::uuid, g.ord::int
  from jsonb_array_elements_text(coalesce(p -> 'modifier_group_ids', '[]'::jsonb)) with ordinality as g(id, ord)
  on conflict (org_id, product_id, group_id) do nothing;
end
$$;
