-- Hand-written: suppliers (a small directory) and the supplier import (0046 made the table).
--
-- Suppliers are business contacts; a sole trader's name or phone is still personal data, so the same
-- care as customers applies: managers and owners only, writes only through functions, nothing from
-- a file in logs or audit rows (ids and counts only), uploaded files expire after 24 hours.
-- The supplier import reuses the import pipeline (0040-0045); rows are checked by the same
-- app.clean_customer rules (name, email, phone, VAT number, address, notes) and matched by name,
-- case-insensitively, among suppliers that are not archived. Undo archives what the import created
-- (the row stays) and restores what it updated.

-- ---------------------------------------------------------------- RLS
alter table public.suppliers enable row level security;
revoke all on public.suppliers from anon, authenticated;
grant select on public.suppliers to authenticated;
create policy suppliers_select on public.suppliers for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create trigger suppliers_touch before update on public.suppliers
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- import settings for the new type
create or replace function public.create_import(
  p_org uuid, p_id uuid, p_file_name text, p_bytes bytea, p_total int, p_type text default 'products'
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_type not in ('products', 'stock', 'customers', 'suppliers') then
    raise exception 'unknown import type' using errcode = '22023';
  end if;
  if p_total not between 1 and 50000 then
    raise exception 'row count out of range' using errcode = '22023';
  end if;
  -- An import that never finished (server restart, lost job) must not block the shop for ever.
  update public.import_jobs
     set status = 'failed', failure = 'stalled', finished_at = now()
   where org_id = p_org and status in ('queued', 'running') and created_at < now() - interval '2 hours';
  if exists (select 1 from public.import_jobs where org_id = p_org and status in ('queued', 'running')) then
    raise exception 'import_in_progress' using errcode = '55006';
  end if;
  -- A new upload replaces an earlier one that was never started; only the newest 10 files are kept.
  delete from public.import_files f using public.import_jobs j
   where j.org_id = p_org and j.id = f.import_id and j.status = 'uploaded';
  update public.import_jobs set status = 'failed', failure = 'replaced', finished_at = now()
   where org_id = p_org and status = 'uploaded';
  delete from public.import_files
   where org_id = p_org
     and import_id in (select import_id from public.import_files where org_id = p_org
                        order by expires_at desc, import_id offset 9);
  insert into public.import_jobs (id, org_id, created_by, type, file_name, total_rows, batch_id)
  values (p_id, p_org, v_user, p_type, left(p_file_name, 200), p_total, gen_random_uuid());
  insert into public.import_files (import_id, org_id, bytes) values (p_id, p_org, p_bytes);
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, v_user, 'import.uploaded', 'import', p_id);
end
$$;
create or replace function public.confirm_import(p_org uuid, p_id uuid, p_mode text, p_match_key text, p_mapping jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_type text;
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select type into v_type from public.import_jobs where org_id = p_org and id = p_id;
  if v_type is null then
    raise exception 'import not found' using errcode = '22023';
  end if;
  if jsonb_typeof(p_mapping) is distinct from 'object' or octet_length(p_mapping::text) > 8000
     or not (
       (v_type = 'products' and p_mode in ('create', 'upsert') and p_match_key in ('sku', 'barcode'))
       or (v_type = 'stock' and p_mode in ('count', 'received') and p_match_key in ('sku', 'barcode'))
       or (v_type = 'customers' and p_mode in ('create', 'upsert') and p_match_key = 'email')
       or (v_type = 'suppliers' and p_mode in ('create', 'upsert') and p_match_key = 'name')
     ) then
    raise exception 'bad import settings' using errcode = '22023';
  end if;
  update public.import_jobs
     set status = 'queued', mode = p_mode, match_key = p_match_key, mapping = p_mapping
   where org_id = p_org and id = p_id and created_by = v_user and status in ('uploaded', 'queued');
  if not found then
    raise exception 'import not found' using errcode = '22023';
  end if;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, v_user, 'import.confirmed', 'import', p_id);
end
$$;

create or replace function public.undo_import(p_org uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  j public.import_jobs%rowtype;
  c public.import_changes%rowtype;
  v_loc uuid;
  v_reverted int := 0;
  v_n int;
  v_kept int := 0;
  b jsonb;
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into j from public.import_jobs where org_id = p_org and id = p_id for update;
  if not found or j.status not in ('done', 'failed') then
    raise exception 'import not found' using errcode = '22023';
  end if;
  if j.undo_until is null or j.undo_until < now() then
    raise exception 'import_undo_expired' using errcode = '22023';
  end if;
  select id into v_loc from public.locations where org_id = p_org order by created_at, id limit 1;

  for c in select * from public.import_changes where import_id = p_id loop
    begin
      if j.type = 'stock' then
        insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, ref_id, actor_user_id, note)
        values (gen_random_uuid(), p_org, c.variant_id, v_loc, -c.qty_delta, 'adjustment', p_id, v_user, 'Import undone');

      elsif j.type = 'customers' then
        if c.action = 'created' then
          update public.customers
             set name = 'Deleted customer', email = null, phone = null, vat_number = null, address = null,
                 notes = null, marketing_consent_at = null, anonymised_at = now()
           where org_id = p_org and id = c.variant_id and anonymised_at is null;
        get diagnostics v_n = row_count;
        if v_n = 0 then raise exception 'already erased' using errcode = 'P0002'; end if;
        else
          b := c.before;
          update public.customers
             set name = b ->> 'name', email = b ->> 'email', phone = b ->> 'phone',
                 vat_number = b ->> 'vat_number', address = b ->> 'address', notes = b ->> 'notes'
           where org_id = p_org and id = c.variant_id and anonymised_at is null;
          get diagnostics v_n = row_count;
          if v_n = 0 then raise exception 'already erased' using errcode = 'P0002'; end if;
          update public.import_changes set before = null where id = c.id; -- personal data not kept after use
        end if;

      elsif j.type = 'suppliers' then
        if c.action = 'created' then
          -- archived AND scrubbed: a created supplier may be a sole trader's personal data
          update public.suppliers
             set archived_at = now(), name = 'Deleted supplier', email = null, phone = null,
                 vat_number = null, address = null, notes = null
           where org_id = p_org and id = c.variant_id and archived_at is null;
          get diagnostics v_n = row_count;
        else
          b := c.before;
          update public.suppliers
             set name = b ->> 'name', email = b ->> 'email', phone = b ->> 'phone',
                 vat_number = b ->> 'vat_number', address = b ->> 'address', notes = b ->> 'notes'
           where org_id = p_org and id = c.variant_id and archived_at is null;
          get diagnostics v_n = row_count;
          update public.import_changes set before = null where id = c.id;
        end if;
        if v_n = 0 then raise exception 'already archived' using errcode = 'P0002'; end if;

      elsif c.action = 'created' then
        update public.variants set archived_at = now(), sku = null, barcode = null
         where org_id = p_org and id = c.variant_id and archived_at is null;
        delete from public.variant_costs where org_id = p_org and variant_id = c.variant_id;
        if c.opening_stock <> 0 then
          insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, actor_user_id, note)
          values (gen_random_uuid(), p_org, c.variant_id, v_loc, -c.opening_stock, 'adjustment', v_user, 'Import undone');
        end if;
        update public.products pr set archived_at = now()
         where pr.org_id = p_org and pr.archived_at is null
           and pr.id = (select x.product_id from public.variants x where x.org_id = p_org and x.id = c.variant_id)
           and not exists (select 1 from public.variants y
                            where y.org_id = p_org and y.product_id = pr.id and y.archived_at is null);
      else
        b := c.before;
        update public.variants
           set name = b -> 'variant' ->> 'name', sku = b -> 'variant' ->> 'sku',
               barcode = b -> 'variant' ->> 'barcode',
               price_incl_vat_cents = (b -> 'variant' ->> 'price')::int,
               attributes = b -> 'variant' -> 'attributes'
         where org_id = p_org and id = c.variant_id;
        if jsonb_typeof(b -> 'cost') = 'number' then
          insert into public.variant_costs (variant_id, org_id, cost_cents)
          values (c.variant_id, p_org, (b ->> 'cost')::int)
          on conflict (variant_id) do update set cost_cents = excluded.cost_cents
            where public.variant_costs.org_id = excluded.org_id;
        else
          delete from public.variant_costs where org_id = p_org and variant_id = c.variant_id;
        end if;
        update public.products
           set name = b -> 'product' ->> 'name', category_id = (b -> 'product' ->> 'category_id')::uuid,
               tax_category = b -> 'product' ->> 'tax_category',
               takeaway_tax_category = b -> 'product' ->> 'takeaway_tax_category',
               track_stock = (b -> 'product' ->> 'track_stock')::boolean
         where org_id = p_org and id = (b -> 'product' ->> 'id')::uuid;
      end if;
      v_reverted := v_reverted + 1;
    exception when others then
      v_kept := v_kept + 1;
    end;
  end loop;

  update public.import_jobs set status = 'undone', undone_at = now() where id = p_id;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (gen_random_uuid(), p_org, v_user, 'import.undone', 'import', p_id,
          jsonb_build_object('reverted', v_reverted, 'kept', v_kept));
  return jsonb_build_object('reverted', v_reverted, 'kept', v_kept);
end
$$;

-- ---------------------------------------------------------------- ops.import_apply_suppliers
-- p: {import_id, user_id, items:[{ref, id, fields:{name,email,phone,vat_number,address,notes}, set:[...]}]}
-- `id` is derived by the caller from the import and the row. An update changes only the fields the
-- file gave a value for; the name is only re-cased.
create function ops.import_apply_suppliers(p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j public.import_jobs%rowtype;
  v_out jsonb := '[]'::jsonb;
  item jsonb;
  c jsonb;
  v_id uuid;
  v_existing uuid;
  v_ns int := 0;
  v_rows int := 0;
  v_ns0 int;
  v_rows0 int;
begin
  select * into j from public.import_jobs where id = (p ->> 'import_id')::uuid for update;
  if not found or j.status <> 'running' or j.type <> 'suppliers' then
    raise exception 'import not running' using errcode = '55000';
  end if;
  if j.created_by <> (p ->> 'user_id')::uuid or not app.is_manager(j.created_by, j.org_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') > 500 then
    raise exception 'bad batch' using errcode = '22023';
  end if;

  for item in select value from jsonb_array_elements(p -> 'items') loop
    v_ns0 := v_ns;
    v_rows0 := v_rows;
    begin
      v_rows := v_rows + 1;
      c := app.clean_customer(item -> 'fields'); -- same field rules as customers
      v_id := (item ->> 'id')::uuid;

      if exists (select 1 from public.import_changes where import_id = j.id and variant_id = v_id) then
        v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'ok'); -- an earlier attempt did it
        continue;
      end if;

      select id into v_existing from public.suppliers
       where org_id = j.org_id and lower(btrim(name)) = lower(c ->> 'name') and archived_at is null limit 1;

      if v_existing is not null and exists (
           select 1 from public.import_changes where import_id = j.id and variant_id = v_existing) then
        v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'ok'); -- an earlier attempt updated it
        continue;
      end if;

      if v_existing is not null and j.mode = 'create' then
        v_ns := v_ns + 1;
      elsif v_existing is not null then
        insert into public.import_changes (id, org_id, import_id, variant_id, action, before)
        select gen_random_uuid(), j.org_id, j.id, x.id, 'updated',
               jsonb_build_object('name', x.name, 'email', x.email, 'phone', x.phone,
                                  'vat_number', x.vat_number, 'address', x.address, 'notes', x.notes)
          from public.suppliers x where x.org_id = j.org_id and x.id = v_existing;
        update public.suppliers set
          name = c ->> 'name',
          email = case when item -> 'set' ? 'email' then c ->> 'email' else email end,
          phone = case when item -> 'set' ? 'phone' then c ->> 'phone' else phone end,
          vat_number = case when item -> 'set' ? 'vat_number' then c ->> 'vat_number' else vat_number end,
          address = case when item -> 'set' ? 'address' then c ->> 'address' else address end,
          notes = case when item -> 'set' ? 'notes' then c ->> 'notes' else notes end
         where org_id = j.org_id and id = v_existing;
      else
        insert into public.suppliers (id, org_id, name, email, phone, vat_number, address, notes)
        values (v_id, j.org_id, c ->> 'name', c ->> 'email', c ->> 'phone', c ->> 'vat_number',
                c ->> 'address', c ->> 'notes');
        insert into public.import_changes (id, org_id, import_id, variant_id, action)
        values (gen_random_uuid(), j.org_id, j.id, v_id, 'created');
      end if;
      v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'ok');
    exception when others then
      v_ns := v_ns0;
      v_rows := v_rows0;
      v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'error', 'code', sqlstate);
    end;
    v_existing := null;
  end loop;

  update public.import_jobs set
    processed_rows = processed_rows + v_rows,
    created_count = (select count(*) from public.import_changes where import_id = j.id and action = 'created'),
    updated_count = (select count(*) from public.import_changes where import_id = j.id and action = 'updated'),
    skipped_count = skipped_count + v_ns
  where id = j.id;
  return v_out;
end
$$;
revoke all on function ops.import_apply_suppliers(jsonb) from public, anon, authenticated;
grant execute on function ops.import_apply_suppliers(jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- public.import_existing_supplier_names
-- Which of these names (lower-cased) already belong to a supplier (RLS applies: managers and owners).
create function public.import_existing_supplier_names(p_org uuid, p_names text[]) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(lower(btrim(name))), '[]'::jsonb) from public.suppliers
   where org_id = p_org and archived_at is null and lower(btrim(name)) = any (p_names)
$$;
revoke all on function public.import_existing_supplier_names(uuid, text[]) from public, anon;
grant execute on function public.import_existing_supplier_names(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------- supplier files expire after 24 hours too
create or replace function app.import_file_expiry() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.import_jobs
              where id = new.import_id and org_id = new.org_id and type in ('customers', 'suppliers')) then
    new.expires_at := least(new.expires_at, now() + interval '24 hours');
  end if;
  return new;
end
$$;

-- ---------------------------------------------------------------- old values are not kept after the undo window
-- import_changes.before holds a customer's or supplier's previous details so an undo can restore them.
-- Once the 24-hour window has passed (or the import was undone) nothing can use them: clear them. The
-- purge job runs hourly. (The file purge is unchanged.)
create or replace function ops.import_purge() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  n int;
begin
  delete from public.import_files where expires_at < now();
  get diagnostics n = row_count;
  update public.import_changes c set before = null
   where c.before is not null
     and exists (select 1 from public.import_jobs j
                  where j.id = c.import_id and (j.undo_until < now() or j.status = 'undone'));
  return n;
end
$$;
