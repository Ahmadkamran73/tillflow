-- Hand-written: categories RLS, onboarding and business-type change.
-- Both functions are owner-only (app.owner_org_ids(), so owners need aal2), write the audit row
-- clients cannot insert themselves, and never update or delete existing categories.

-- ---------------------------------------------------------------- categories
alter table public.categories enable row level security;
revoke all on public.categories from anon, authenticated;
grant select on public.categories to authenticated;
grant insert (id, org_id, name, parent_id, colour, sort) on public.categories to authenticated;
grant update (name, parent_id, colour, sort) on public.categories to authenticated;
grant delete on public.categories to authenticated;

create policy categories_select on public.categories for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy categories_insert on public.categories for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy categories_update on public.categories for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));
create policy categories_delete on public.categories for delete to authenticated
  using (org_id in (select app.owner_org_ids()));

create trigger categories_touch before update on public.categories
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- organisations
-- Business type changes only through set_business_type (audit row + starter categories).
revoke update (business_type) on public.organisations from authenticated;

-- ---------------------------------------------------------------- shared: add starter categories
-- p_categories: [{"id": uuid, "name": text, "colour": "#RRGGBB" | null}, ...]. Names already in
-- the org are skipped (never renamed or recoloured). Internal: no client execute.
create function app.add_starter_categories(p_org_id uuid, p_categories jsonb)
returns void
language plpgsql set search_path = ''
as $$
begin
  if jsonb_typeof(p_categories) <> 'array' or jsonb_array_length(p_categories) > 40 then
    raise exception 'categories must be an array of at most 40 items' using errcode = '22023';
  end if;
  insert into public.categories (id, org_id, name, colour, sort)
  select (c.value ->> 'id')::uuid, p_org_id, btrim(c.value ->> 'name'), c.value ->> 'colour',
         coalesce((select max(sort) from public.categories where org_id = p_org_id), 0) + c.ord::int * 10
  from jsonb_array_elements(p_categories) with ordinality as c(value, ord)
  where char_length(btrim(c.value ->> 'name')) between 1 and 60
  on conflict (org_id, name) do nothing;
end
$$;
revoke all on function app.add_starter_categories(uuid, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- complete_onboarding
create function public.complete_onboarding(
  p_org_id uuid,
  p_name text,
  p_vat_number text,
  p_business_type public.business_type,
  p_location_id uuid,
  p_register_ids uuid[],
  p_categories jsonb,
  p_audit_id uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_name text := btrim(coalesce(p_name, ''));
  v_vat text := nullif(btrim(coalesce(p_vat_number, '')), '');
  v_tills int := coalesce(array_length(p_register_ids, 1), 0);
begin
  if v_user is null or p_org_id is null or not exists (select 1 from app.owner_org_ids() o where o = p_org_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_business_type is null or p_location_id is null or p_audit_id is null then
    raise exception 'business type and ids are required' using errcode = '22023';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception 'organisation name must be 1 to 120 characters' using errcode = '22023';
  end if;
  if char_length(v_vat) > 20 then
    raise exception 'VAT number too long' using errcode = '22023';
  end if;
  if v_tills < 1 or v_tills > 20 then
    raise exception 'between 1 and 20 tills' using errcode = '22023';
  end if;

  -- Serialise a double submit; the second one finds onboarded_at set and does nothing.
  perform pg_advisory_xact_lock(hashtextextended('onboarding:' || p_org_id::text, 0));
  if (select onboarded_at from public.organisations where id = p_org_id) is not null then
    return;
  end if;

  update public.organisations
     set name = v_name, vat_number = v_vat, business_type = p_business_type, onboarded_at = now()
   where id = p_org_id;

  insert into public.locations (id, org_id, name) values (p_location_id, p_org_id, v_name);
  insert into public.registers (id, org_id, location_id, name)
  select r.id, p_org_id, p_location_id, 'Till ' || r.n
  from unnest(p_register_ids) with ordinality as r(id, n);

  perform app.add_starter_categories(p_org_id, p_categories);

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (p_audit_id, p_org_id, v_user, 'organisation.onboarded', 'organisation', p_org_id,
          jsonb_build_object('business_type', p_business_type, 'tills', v_tills));
end
$$;

revoke all on function public.complete_onboarding(uuid, text, text, public.business_type, uuid, uuid[], jsonb, uuid) from public, anon;
grant execute on function public.complete_onboarding(uuid, text, text, public.business_type, uuid, uuid[], jsonb, uuid) to authenticated;

-- ---------------------------------------------------------------- set_business_type
-- Switches presets only: products, categories and sales are kept; missing starter categories are added.
create function public.set_business_type(
  p_org_id uuid,
  p_business_type public.business_type,
  p_categories jsonb,
  p_audit_id uuid
)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_before public.business_type;
begin
  if v_user is null or p_org_id is null or not exists (select 1 from app.owner_org_ids() o where o = p_org_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_business_type is null or p_audit_id is null then
    raise exception 'business type and audit id are required' using errcode = '22023';
  end if;

  select business_type into v_before from public.organisations where id = p_org_id for update;
  update public.organisations set business_type = p_business_type where id = p_org_id;
  perform app.add_starter_categories(p_org_id, p_categories);

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, before, after)
  values (p_audit_id, p_org_id, v_user, 'organisation.business_type_changed', 'organisation', p_org_id,
          jsonb_build_object('business_type', v_before), jsonb_build_object('business_type', p_business_type));
end
$$;

revoke all on function public.set_business_type(uuid, public.business_type, jsonb, uuid) from public, anon;
grant execute on function public.set_business_type(uuid, public.business_type, jsonb, uuid) to authenticated;
