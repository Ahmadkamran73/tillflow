-- Hand-written: two small follow-ups to the import types (0042-0044).
--
-- 1. public.import_stock_keys: the stock preview must say which SKUs/barcodes exist AND are
--    stock-tracked, because the job refuses an untracked product (22023). SECURITY INVOKER: RLS applies,
--    so it only ever sees this shop's products and only for managers/owners.
-- 2. Customer files expire after 24 hours, not 7 days. An uploaded customer file holds personal data
--    that the import needs only until it has been read by the job and checked/downloaded by the manager;
--    undo works from import_changes, not from the file. Enforced by the database (a trigger on insert)
--    and removed by the existing hourly ops.import_purge; a file that has expired answers "expired" in
--    the preview and problem-file routes.

create function public.import_stock_keys(p_org uuid, p_keys text[], p_by text) returns jsonb
language sql stable security invoker set search_path = ''
as $$
  select jsonb_build_object(
    'tracked', coalesce(jsonb_agg(k) filter (where tracked), '[]'::jsonb),
    'untracked', coalesce(jsonb_agg(k) filter (where not tracked), '[]'::jsonb))
  from (
    select distinct on (k) k, tracked from (
      select case when p_by = 'barcode' then v.barcode else v.sku end as k, pr.track_stock as tracked
        from public.variants v
        join public.products pr on pr.org_id = v.org_id and pr.id = v.product_id
       where v.org_id = p_org and v.archived_at is null
         and case when p_by = 'barcode' then v.barcode else v.sku end = any (p_keys)
    ) x order by k, tracked desc
  ) y
$$;
revoke all on function public.import_stock_keys(uuid, text[], text) from public, anon;
grant execute on function public.import_stock_keys(uuid, text[], text) to authenticated;

create function app.import_file_expiry() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if exists (select 1 from public.import_jobs where id = new.import_id and org_id = new.org_id and type = 'customers') then
    new.expires_at := least(new.expires_at, now() + interval '24 hours');
  end if;
  return new;
end
$$;
revoke all on function app.import_file_expiry() from public, anon, authenticated;
create trigger import_files_customer_expiry before insert on public.import_files
  for each row execute function app.import_file_expiry();

-- 3. Saved column matches are per kind of import (0044 added import_mappings.type). The API role has
--    column-level grants on this table (see 0041), so the new column needs its insert grant too.
grant insert (type) on public.import_mappings to authenticated;
