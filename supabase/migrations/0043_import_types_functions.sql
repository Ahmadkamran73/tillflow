-- Hand-written: stock and customer imports on the same pipeline as product imports (0040-0042).
--
-- An import now has a type (products, stock, customers). The upload, mapping, preview, background job,
-- progress and 24-hour undo are shared; what differs is the batch writer and what undo does:
--   stock      a counted or delivered quantity per SKU/barcode, written to the stock ledger (reasons
--              'count' and 'received', like the manual screen); undo adds the opposite 'adjustment'
--   customers  rows are checked by the same app.clean_customer as the customers screen; created
--              customers are anonymised on undo (never hard-deleted), updated ones are restored.
--              Marketing consent is NEVER imported: it needs an explicit tick per customer.
-- Same trust model as 0041: the ops.* functions are callable only by the job role and re-check that
-- the import's creator is still a manager of the shop; every write is scoped by the import's org_id.

-- ---------------------------------------------------------------- public.create_import (with a type)
drop function public.create_import(uuid, uuid, text, bytea, int);
create function public.create_import(
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
  if p_type not in ('products', 'stock', 'customers') then
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
revoke all on function public.create_import(uuid, uuid, text, bytea, int, text) from public, anon;
grant execute on function public.create_import(uuid, uuid, text, bytea, int, text) to authenticated;

-- ---------------------------------------------------------------- public.confirm_import (rules per type)
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

-- ---------------------------------------------------------------- ops.import_begin (also answers the type)
create or replace function ops.import_begin(p_import uuid, p_user uuid) returns jsonb
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
    'org_id', j.org_id, 'type', j.type, 'mode', j.mode, 'match_key', j.match_key, 'mapping', j.mapping,
    'file_name', j.file_name, 'total_rows', j.total_rows,
    'business_type', (select o.business_type from public.organisations o where o.id = j.org_id));
end
$$;

-- ---------------------------------------------------------------- ops.import_apply_stock
-- p: {import_id, user_id, items:[{ref, key, qty, note}]}; the job's match_key says whether `key` is a
-- SKU or a barcode and its mode says 'count' (the number is what is on the shelf) or 'received' (the
-- number is added). Each row runs in its own sub-transaction. Answers [{ref, status, code}] with the
-- SQLSTATE only: P0002 = no such product, 22023 = not stock-tracked or a bad quantity.
create function ops.import_apply_stock(p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j public.import_jobs%rowtype;
  v_loc uuid;
  v_out jsonb := '[]'::jsonb;
  item jsonb;
  v_variant uuid;
  v_track boolean;
  v_key text;
  v_qty int;
  v_on_hand int;
  v_delta int;
  v_note text;
  v_ns int := 0;
  v_rows int := 0;
  v_ns0 int;
  v_rows0 int;
begin
  select * into j from public.import_jobs where id = (p ->> 'import_id')::uuid for update;
  if not found or j.status <> 'running' or j.type <> 'stock' then
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
    v_ns0 := v_ns;
    v_rows0 := v_rows;
    begin
      v_rows := v_rows + 1;
      v_key := nullif(btrim(item ->> 'key'), '');
      v_qty := (item ->> 'qty')::int;
      v_note := left(nullif(btrim(coalesce(item ->> 'note', '')), ''), 200);

      v_variant := null;
      if v_key is not null then
        select v.id, pr.track_stock into v_variant, v_track
          from public.variants v join public.products pr on pr.org_id = v.org_id and pr.id = v.product_id
         where v.org_id = j.org_id and v.archived_at is null
           and case j.match_key when 'barcode' then v.barcode else v.sku end = v_key
         limit 1;
      end if;
      if v_variant is null then
        raise exception 'no such product' using errcode = 'P0002';
      end if;
      if not v_track then
        raise exception 'not stock-tracked' using errcode = '22023';
      end if;

      if exists (select 1 from public.import_changes where import_id = j.id and variant_id = v_variant) then
        v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'ok'); -- an earlier attempt did it
        continue;
      end if;

      if j.mode = 'count' then
        if v_qty is null or v_qty not between 0 and 1000000 then
          raise exception 'bad count' using errcode = '22023';
        end if;
        perform pg_advisory_xact_lock(hashtextextended(v_variant::text || v_loc::text, 0));
        select coalesce((select on_hand from public.stock_levels
                          where org_id = j.org_id and variant_id = v_variant and location_id = v_loc), 0)
          into v_on_hand;
        v_delta := v_qty - v_on_hand;
      else
        if v_qty is null or v_qty not between 1 and 1000000 then
          raise exception 'bad quantity' using errcode = '22023';
        end if;
        v_delta := v_qty;
      end if;

      if v_delta = 0 then
        v_ns := v_ns + 1; -- the count equals what the system already shows
      else
        insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, ref_id, actor_user_id, note)
        values (gen_random_uuid(), j.org_id, v_variant, v_loc, v_delta, j.mode, j.id, j.created_by,
                coalesce(v_note, 'Import'));
        insert into public.import_changes (id, org_id, import_id, variant_id, action, qty_delta)
        values (gen_random_uuid(), j.org_id, j.id, v_variant, 'stock', v_delta);
      end if;
      v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'ok');
    exception when others then
      v_ns := v_ns0;
      v_rows := v_rows0;
      v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'error', 'code', sqlstate);
    end;
  end loop;

  update public.import_jobs set
    processed_rows = processed_rows + v_rows,
    updated_count = (select count(*) from public.import_changes where import_id = j.id and action = 'stock'),
    skipped_count = skipped_count + v_ns
  where id = j.id;
  return v_out;
end
$$;
revoke all on function ops.import_apply_stock(jsonb) from public, anon, authenticated;
grant execute on function ops.import_apply_stock(jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.import_apply_customers
-- p: {import_id, user_id, items:[{ref, id, fields:{name,email,phone,vat_number,address,notes}, set:[...]}]}
-- `id` is derived by the caller from the import and the row (a retried batch finds its own earlier
-- work). Matching is by e-mail (case-insensitive). An update changes the name and only the other
-- fields the file gave a value for. Consent is not a field here and is never set.
create function ops.import_apply_customers(p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  j public.import_jobs%rowtype;
  v_out jsonb := '[]'::jsonb;
  item jsonb;
  c jsonb;
  v_id uuid;
  v_email text;
  v_existing uuid;
  v_ns int := 0;
  v_rows int := 0;
  v_ns0 int;
  v_rows0 int;
begin
  select * into j from public.import_jobs where id = (p ->> 'import_id')::uuid for update;
  if not found or j.status <> 'running' or j.type <> 'customers' then
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
      c := app.clean_customer(item -> 'fields'); -- the customers screen's own checks
      v_id := (item ->> 'id')::uuid;
      v_email := c ->> 'email';

      if exists (select 1 from public.import_changes where import_id = j.id and variant_id = v_id) then
        v_out := v_out || jsonb_build_object('ref', item ->> 'ref', 'status', 'ok'); -- an earlier attempt did it
        continue;
      end if;

      v_existing := null;
      if v_email is not null then
        select id into v_existing from public.customers
         where org_id = j.org_id and lower(email) = v_email and anonymised_at is null limit 1;
      end if;

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
          from public.customers x where x.org_id = j.org_id and x.id = v_existing;
        update public.customers set
          name = c ->> 'name',
          phone = case when item -> 'set' ? 'phone' then c ->> 'phone' else phone end,
          vat_number = case when item -> 'set' ? 'vat_number' then c ->> 'vat_number' else vat_number end,
          address = case when item -> 'set' ? 'address' then c ->> 'address' else address end,
          notes = case when item -> 'set' ? 'notes' then c ->> 'notes' else notes end
         where org_id = j.org_id and id = v_existing;
      else
        insert into public.customers (id, org_id, name, email, phone, vat_number, address, notes)
        values (v_id, j.org_id, c ->> 'name', v_email, c ->> 'phone', c ->> 'vat_number',
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
revoke all on function ops.import_apply_customers(jsonb) from public, anon, authenticated;
grant execute on function ops.import_apply_customers(jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- public.import_existing_emails
-- Which of these addresses already belong to a customer (RLS applies: managers and owners only).
create function public.import_existing_emails(p_org uuid, p_emails text[]) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select coalesce(jsonb_agg(lower(email)), '[]'::jsonb) from public.customers
   where org_id = p_org and anonymised_at is null and lower(email) = any (p_emails)
$$;
revoke all on function public.import_existing_emails(uuid, text[]) from public, anon;
grant execute on function public.import_existing_emails(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------- public.undo_import (all three types)
-- Within 24 hours of finishing (or of failing part-way). products: created variants are archived, updated
-- ones restored, opening stock reversed. stock: the opposite 'adjustment' is added for each change.
-- customers: created customers are anonymised (the row stays), updated ones are restored. A change that
-- cannot be put back is left as it is and counted in 'kept'.
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

-- ---------------------------------------------------------------- ops.import_apply_batch only for product imports
-- The 0041 function predates import types: wrap it so a stock or customers import can never be fed
-- through the product writer (same job role, same creator check inside the core).
alter function ops.import_apply_batch(jsonb) rename to import_apply_batch_core;
revoke all on function ops.import_apply_batch_core(jsonb) from public, anon, authenticated, service_role, tillflow_ops;
create function ops.import_apply_batch(p jsonb) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.import_jobs
                  where id = (p ->> 'import_id')::uuid and type = 'products') then
    raise exception 'import not running' using errcode = '55000';
  end if;
  return ops.import_apply_batch_core(p);
end
$$;
revoke all on function ops.import_apply_batch(jsonb) from public, anon, authenticated;
grant execute on function ops.import_apply_batch(jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- erasure also clears import_changes.before
-- An updated customer's old values are kept in import_changes.before for undo. When the customer is
-- anonymised (by the erase button or by an undo) those old values must go too.
create function app.scrub_import_before() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.anonymised_at is not null and old.anonymised_at is null then
    update public.import_changes set before = null where org_id = new.org_id and variant_id = new.id;
  end if;
  return new;
end
$$;
revoke all on function app.scrub_import_before() from public, anon, authenticated;
create trigger customers_scrub_import_before after update of anonymised_at on public.customers
  for each row execute function app.scrub_import_before();
