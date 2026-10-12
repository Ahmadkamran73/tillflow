-- Hand-written: bulk product import (docs/specs/bulk-import.md).
--
-- Clients (managers and owners) can SELECT the import list; the uploaded file is not readable by
-- any client role at all. Every write goes through a function that checks the role. The background
-- job has no user session, so it uses ops.* functions that take the acting user id and check it with
-- app.is_manager (the membership lookup stays in one place). Nothing here runs user-supplied SQL.

-- ---------------------------------------------------------------- RLS and grants
alter table public.import_jobs enable row level security;
alter table public.import_files enable row level security;
alter table public.import_mappings enable row level security;
alter table public.import_changes enable row level security;

revoke all on public.import_jobs, public.import_files, public.import_mappings, public.import_changes
  from anon, authenticated;
grant select on public.import_jobs to authenticated;
grant select on public.import_changes to authenticated;
grant select, delete on public.import_mappings to authenticated;
grant insert (id, org_id, name, mapping) on public.import_mappings to authenticated;
-- import_files: no grant and a deny-all policy, so no client can read or write the bytes; only the
-- role-checked functions below (and the job's ops functions) reach them.
create policy import_files_deny on public.import_files for all to authenticated
  using (false) with check (false);

create policy import_jobs_select on public.import_jobs for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy import_changes_select on public.import_changes for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy import_mappings_select on public.import_mappings for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy import_mappings_insert on public.import_mappings for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy import_mappings_delete on public.import_mappings for delete to authenticated
  using (org_id in (select app.manager_org_ids()));

-- ---------------------------------------------------------------- public.create_import
-- Stores the parsed-and-checked upload. One open import per shop at a time.
create function public.create_import(p_org uuid, p_id uuid, p_file_name text, p_bytes bytea, p_total int)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
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
  -- A new upload replaces an earlier one that was never started; only the newest 10 files are kept per shop (the oldest is dropped).
  delete from public.import_files f using public.import_jobs j
   where j.org_id = p_org and j.id = f.import_id and j.status = 'uploaded';
  update public.import_jobs set status = 'failed', failure = 'replaced', finished_at = now()
   where org_id = p_org and status = 'uploaded';
  delete from public.import_files
   where org_id = p_org
     and import_id in (select import_id from public.import_files where org_id = p_org
                        order by expires_at desc, import_id offset 9);
  insert into public.import_jobs (id, org_id, created_by, file_name, total_rows, batch_id)
  values (p_id, p_org, v_user, left(p_file_name, 200), p_total, gen_random_uuid());
  insert into public.import_files (import_id, org_id, bytes) values (p_id, p_org, p_bytes);
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, v_user, 'import.uploaded', 'import', p_id);
end
$$;
revoke all on function public.create_import(uuid, uuid, text, bytea, int) from public, anon;
grant execute on function public.create_import(uuid, uuid, text, bytea, int) to authenticated;

-- ---------------------------------------------------------------- public.get_import_file
create function public.get_import_file(p_org uuid, p_id uuid) returns bytea
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_bytes bytea;
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select bytes into v_bytes from public.import_files where org_id = p_org and import_id = p_id;
  return v_bytes; -- null once the 7-day copy has been purged
end
$$;
revoke all on function public.get_import_file(uuid, uuid) from public, anon;
grant execute on function public.get_import_file(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- public.confirm_import
create function public.confirm_import(p_org uuid, p_id uuid, p_mode text, p_match_key text, p_mapping jsonb)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode not in ('create', 'upsert') or p_match_key not in ('sku', 'barcode')
     or jsonb_typeof(p_mapping) is distinct from 'object' or octet_length(p_mapping::text) > 8000 then
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
revoke all on function public.confirm_import(uuid, uuid, text, text, jsonb) from public, anon;
grant execute on function public.confirm_import(uuid, uuid, text, text, jsonb) to authenticated;

-- ---------------------------------------------------------------- public.import_existing_keys
-- Which of these SKUs / barcodes already belong to an active variant (RLS applies: SECURITY INVOKER).
create function public.import_existing_keys(p_org uuid, p_skus text[], p_barcodes text[]) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'skus', coalesce((select jsonb_agg(sku) from public.variants
                       where org_id = p_org and archived_at is null and sku = any (p_skus)), '[]'::jsonb),
    'barcodes', coalesce((select jsonb_agg(barcode) from public.variants
                           where org_id = p_org and archived_at is null and barcode = any (p_barcodes)), '[]'::jsonb))
$$;
revoke all on function public.import_existing_keys(uuid, text[], text[]) from public, anon;
grant execute on function public.import_existing_keys(uuid, text[], text[]) to authenticated;

-- ---------------------------------------------------------------- ops.import_begin / file / finish
create function ops.import_begin(p_import uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j public.import_jobs%rowtype;
begin
  select * into j from public.import_jobs where id = p_import for update;
  if not found or j.status <> 'queued' then
    return null; -- nothing to do (already running or finished, or never confirmed)
  end if;
  if j.created_by <> p_user or not app.is_manager(p_user, j.org_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.import_jobs
     set status = 'running', processed_rows = 0, created_count = 0, updated_count = 0, skipped_count = 0
   where id = p_import;
  return jsonb_build_object(
    'org_id', j.org_id, 'mode', j.mode, 'match_key', j.match_key, 'mapping', j.mapping,
    'file_name', j.file_name, 'total_rows', j.total_rows,
    'business_type', (select o.business_type from public.organisations o where o.id = j.org_id));
end
$$;
revoke all on function ops.import_begin(uuid, uuid) from public, anon, authenticated;
grant execute on function ops.import_begin(uuid, uuid) to service_role, tillflow_ops;

create function ops.import_file(p_import uuid) returns bytea
language sql stable security definer set search_path = ''
as $$
  select f.bytes from public.import_files f join public.import_jobs j on j.id = f.import_id
   where f.import_id = p_import and j.status = 'running'
$$;
revoke all on function ops.import_file(uuid) from public, anon, authenticated;
grant execute on function ops.import_file(uuid) to service_role, tillflow_ops;

create function ops.import_finish(p_import uuid, p_ok boolean, p_error_count int, p_errors jsonb, p_failure text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  j public.import_jobs%rowtype;
begin
  update public.import_jobs
     set status = case when p_ok then 'done' else 'failed' end,
         error_count = p_error_count, errors = coalesce(p_errors, '[]'::jsonb),
         failure = left(p_failure, 200), finished_at = now(),
         undo_until = now() + interval '24 hours'
   where id = p_import and status = 'running'
  returning * into j;
  if found then
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (gen_random_uuid(), j.org_id, j.created_by,
            case when p_ok then 'import.finished' else 'import.failed' end, 'import', p_import,
            jsonb_build_object('created', j.created_count, 'updated', j.updated_count,
                               'skipped', j.skipped_count, 'errors', p_error_count));
  end if;
end
$$;
revoke all on function ops.import_finish(uuid, boolean, int, jsonb, text) from public, anon, authenticated;
grant execute on function ops.import_finish(uuid, boolean, int, jsonb, text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.import_apply_batch
-- p: {import_id, user_id, items:[{ref, category, product:{id,name,tax_category,takeaway_tax_category,
--     track_stock}, variants:[{id,name,sku,barcode,price_incl_vat_cents,cost_cents,attributes,sort,
--     opening_stock}]}]}
-- Each item runs in its own sub-transaction, so a duplicate barcode (or any constraint) turns that
-- item into an error row and the rest of the batch goes on. Ids are chosen by the caller from the
-- import id and row, so a retried batch finds its own earlier work and does not repeat it.
-- Answers [{ref, status: created|updated|skipped|error, code}] (code = SQLSTATE only, no data).
create function ops.import_apply_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j public.import_jobs%rowtype;
  v_loc uuid;
  v_out jsonb := '[]'::jsonb;
  item jsonb;
  v jsonb;
  v_cat uuid;
  v_prior text;
  v_ex_id uuid;
  v_ex_product uuid;
  v_key text;
  v_made_product boolean;
  v_pid uuid;
  v_track boolean;
  v_ns int := 0;
  v_rows int := 0;
  v_qty int;
  v_ns0 int;
  v_rows0 int;
begin
  select * into j from public.import_jobs where id = (p ->> 'import_id')::uuid for update;
  if not found or j.status <> 'running' then
    raise exception 'import not running' using errcode = '55000';
  end if;
  if j.created_by <> (p ->> 'user_id')::uuid or not app.is_manager(j.created_by, j.org_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p -> 'items') is distinct from 'array' or jsonb_array_length(p -> 'items') > 500 then
    raise exception 'bad batch' using errcode = '22023';
  end if;
  select id into v_loc from public.locations where org_id = j.org_id order by created_at, id limit 1;

  for item in select value from jsonb_array_elements(p -> 'items') loop
    v_made_product := false;
    v_ns0 := v_ns;
    v_rows0 := v_rows;
    v_pid := (item -> 'product' ->> 'id')::uuid;
    v_track := coalesce((item -> 'product' ->> 'track_stock')::boolean, true);
    begin
      v_cat := null;
      if nullif(btrim(item ->> 'category'), '') is not null then
        insert into public.categories (id, org_id, name)
        values (gen_random_uuid(), j.org_id, left(btrim(item ->> 'category'), 60))
        on conflict (org_id, name) do nothing;
        select id into v_cat from public.categories
         where org_id = j.org_id and name = left(btrim(item ->> 'category'), 60);
      end if;

      for v in select value from jsonb_array_elements(item -> 'variants') loop
        v_rows := v_rows + 1;
        -- Already done by an earlier attempt of this same import?
        select action into v_prior from public.import_changes
         where import_id = j.id and variant_id = (v ->> 'id')::uuid;
        if found then
          continue;
        end if;

        v_ex_id := null;
        v_key := nullif(case j.match_key when 'barcode' then v ->> 'barcode' else v ->> 'sku' end, '');
        if v_key is not null then
          select x.id, x.product_id into v_ex_id, v_ex_product from public.variants x
           where x.org_id = j.org_id and x.archived_at is null
             and case j.match_key when 'barcode' then x.barcode else x.sku end = v_key
           limit 1;
        end if;

        if v_ex_id is not null and j.mode = 'create' then
          v_ns := v_ns + 1;
        elsif v_ex_id is not null then
          insert into public.import_changes (id, org_id, import_id, variant_id, action, before)
          select gen_random_uuid(), j.org_id, j.id, x.id, 'updated',
                 jsonb_build_object(
                   'variant', jsonb_build_object('name', x.name, 'sku', x.sku, 'barcode', x.barcode,
                     'price', x.price_incl_vat_cents, 'attributes', x.attributes),
                   'cost', (select c.cost_cents from public.variant_costs c where c.variant_id = x.id),
                   'product', jsonb_build_object('id', pr.id, 'name', pr.name, 'category_id', pr.category_id,
                     'tax_category', pr.tax_category, 'takeaway_tax_category', pr.takeaway_tax_category,
                     'track_stock', pr.track_stock))
            from public.variants x join public.products pr on pr.org_id = x.org_id and pr.id = x.product_id
           where x.org_id = j.org_id and x.id = v_ex_id;
          update public.variants
             set name = coalesce(v ->> 'name', ''), sku = coalesce(nullif(v ->> 'sku', ''), sku),
                 barcode = coalesce(nullif(v ->> 'barcode', ''), barcode),
                 price_incl_vat_cents = (v ->> 'price_incl_vat_cents')::int,
                 attributes = attributes || coalesce(
                   (select jsonb_object_agg(k, v -> 'attributes' -> k)
                      from jsonb_array_elements_text(coalesce(v -> 'attr_set', '[]'::jsonb)) k
                     where v -> 'attributes' ? k), '{}'::jsonb)
           where org_id = j.org_id and id = v_ex_id;
          if nullif(v ->> 'cost_cents', '') is not null then
            insert into public.variant_costs (variant_id, org_id, cost_cents)
            values (v_ex_id, j.org_id, (v ->> 'cost_cents')::int)
            on conflict (variant_id) do update set cost_cents = excluded.cost_cents
              where public.variant_costs.org_id = excluded.org_id;
          end if; -- a blank cost column leaves the existing cost alone
          update public.products
             set name = item -> 'product' ->> 'name', category_id = coalesce(v_cat, category_id),
                 tax_category = case when coalesce((item -> 'product' ->> 'tax_set')::boolean, false)
                                then item -> 'product' ->> 'tax_category' else tax_category end,
                 takeaway_tax_category = case when coalesce((item -> 'product' ->> 'tax_set')::boolean, false)
                                then item -> 'product' ->> 'takeaway_tax_category' else takeaway_tax_category end,
                 track_stock = case when coalesce((item -> 'product' ->> 'track_set')::boolean, false)
                                then v_track else track_stock end
           where org_id = j.org_id and id = v_ex_product;
        else
          if not v_made_product then
            insert into public.products (id, org_id, name, category_id, tax_category, takeaway_tax_category, track_stock)
            values (v_pid, j.org_id, item -> 'product' ->> 'name', v_cat,
                    item -> 'product' ->> 'tax_category', item -> 'product' ->> 'takeaway_tax_category', v_track)
            on conflict (id) do nothing;
            v_made_product := true;
          end if;
          insert into public.variants (id, org_id, product_id, name, sku, barcode, price_incl_vat_cents, attributes, sort)
          values ((v ->> 'id')::uuid, j.org_id, v_pid, coalesce(v ->> 'name', ''), nullif(v ->> 'sku', ''),
                  nullif(v ->> 'barcode', ''), (v ->> 'price_incl_vat_cents')::int,
                  coalesce(v -> 'attributes', '{}'::jsonb), coalesce((v ->> 'sort')::int, 0));
          if nullif(v ->> 'cost_cents', '') is not null then
            insert into public.variant_costs (variant_id, org_id, cost_cents)
            values ((v ->> 'id')::uuid, j.org_id, (v ->> 'cost_cents')::int);
          end if;
          v_qty := case when v_track then coalesce((v ->> 'opening_stock')::int, 0) else 0 end;
          if v_qty <> 0 then
            insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, actor_user_id, note)
            values (gen_random_uuid(), j.org_id, (v ->> 'id')::uuid, v_loc, v_qty, 'opening', j.created_by, 'Import');
          end if;
          insert into public.import_changes (id, org_id, import_id, variant_id, action, opening_stock)
          values (gen_random_uuid(), j.org_id, j.id, (v ->> 'id')::uuid, 'created', v_qty);
        end if;
      end loop;
      v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'ok');
    exception when others then
      -- The sub-transaction undid this item's writes (plpgsql variables are not rolled back).
      v_ns := v_ns0;
      v_rows := v_rows0;
      v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'error', 'code', sqlstate);
    end;
  end loop;

  -- Created / updated come from the ledger, which the sub-transactions keep exact.
  update public.import_jobs set
    processed_rows = processed_rows + v_rows,
    created_count = (select count(*) from public.import_changes where import_id = j.id and action = 'created'),
    updated_count = (select count(*) from public.import_changes where import_id = j.id and action = 'updated'),
    skipped_count = skipped_count + v_ns
  where id = j.id;
  return v_out;
end
$$;
revoke all on function ops.import_apply_batch(jsonb) from public, anon, authenticated;
grant execute on function ops.import_apply_batch(jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- public.undo_import
-- Within 24 hours of finishing: rows the import created are archived (never deleted) and their
-- opening stock reversed; rows it updated get their earlier values back. A change that cannot be
-- put back (the SKU was taken since) is left as it is and counted in 'kept'.
create function public.undo_import(p_org uuid, p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  j public.import_jobs%rowtype;
  c public.import_changes%rowtype;
  v_loc uuid;
  v_reverted int := 0;
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
      if c.action = 'created' then
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
revoke all on function public.undo_import(uuid, uuid) from public, anon;
grant execute on function public.undo_import(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- ops.import_purge
-- Hourly: the uploaded file is kept 7 days at most.
create function ops.import_purge() returns int
language plpgsql security definer set search_path = ''
as $$
declare
  n int;
begin
  delete from public.import_files where expires_at < now();
  get diagnostics n = row_count;
  return n;
end
$$;
revoke all on function ops.import_purge() from public, anon, authenticated;
grant execute on function ops.import_purge() to service_role, tillflow_ops;
