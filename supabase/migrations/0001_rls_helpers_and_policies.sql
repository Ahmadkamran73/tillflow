-- Hand-written: org helpers, grants, RLS policies, append-only guard.
-- Every policy uses the app.* helper family; the memberships lookup exists in ONE place
-- (app.org_ids_with_roles) and the auth provider is touched in ONE place (app.current_user_id).

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;

-- New public tables get no client access unless a migration grants it explicitly.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;

-- ---------------------------------------------------------------- helpers

create function app.current_user_id() returns uuid
language sql stable
as $$ select auth.uid() $$;

-- The single membership lookup. security definer so it can read memberships without
-- re-entering memberships' own RLS policy; search_path pinned.
create function app.org_ids_with_roles(roles public.membership_role[]) returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.org_id from public.memberships m
  where m.user_id = (select app.current_user_id()) and m.role = any (roles)
$$;

create function app.current_org_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select app.org_ids_with_roles(array['owner', 'manager', 'cashier']::public.membership_role[]) $$;

create function app.manager_org_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select app.org_ids_with_roles(array['owner', 'manager']::public.membership_role[]) $$;

create function app.owner_org_ids() returns setof uuid
language sql stable security definer set search_path = ''
as $$ select app.org_ids_with_roles(array['owner']::public.membership_role[]) $$;

revoke all on function app.current_user_id() from public;
revoke all on function app.org_ids_with_roles(public.membership_role[]) from public;
revoke all on function app.current_org_ids() from public;
revoke all on function app.manager_org_ids() from public;
revoke all on function app.owner_org_ids() from public;
grant execute on function app.current_user_id() to authenticated, service_role;
grant execute on function app.org_ids_with_roles(public.membership_role[]) to authenticated, service_role;
grant execute on function app.current_org_ids() to authenticated, service_role;
grant execute on function app.manager_org_ids() to authenticated, service_role;
grant execute on function app.owner_org_ids() to authenticated, service_role;

create function app.touch_updated_at() returns trigger
language plpgsql
as $$ begin new.updated_at := now(); return new; end $$;

create trigger organisations_touch before update on public.organisations
  for each row execute function app.touch_updated_at();
create trigger memberships_touch before update on public.memberships
  for each row execute function app.touch_updated_at();
create trigger locations_touch before update on public.locations
  for each row execute function app.touch_updated_at();
create trigger registers_touch before update on public.registers
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------- organisations
-- Created only by the sign-up flow (service role). Owners may edit profile fields, never plan/status/trial.
alter table public.organisations enable row level security;
revoke all on public.organisations from anon, authenticated;
grant select on public.organisations to authenticated;
grant update (name, legal_name, vat_number, cro_number, business_type) on public.organisations to authenticated;

create policy organisations_select on public.organisations for select to authenticated
  using (id in (select app.current_org_ids()));
create policy organisations_update on public.organisations for update to authenticated
  using (id in (select app.owner_org_ids()))
  with check (id in (select app.owner_org_ids()));

-- ---------------------------------------------------------------- memberships
-- Owner-only writes. pin_hash is never readable or writable by clients (server sets it).
alter table public.memberships enable row level security;
revoke all on public.memberships from anon, authenticated;
grant select (id, org_id, user_id, role, location_ids, created_at, updated_at) on public.memberships to authenticated;
grant insert (id, org_id, user_id, role, location_ids) on public.memberships to authenticated;
grant update (role, location_ids) on public.memberships to authenticated;
grant delete on public.memberships to authenticated;

create policy memberships_select on public.memberships for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy memberships_insert on public.memberships for insert to authenticated
  with check (org_id in (select app.owner_org_ids()));
create policy memberships_update on public.memberships for update to authenticated
  using (org_id in (select app.owner_org_ids()))
  with check (org_id in (select app.owner_org_ids()));
create policy memberships_delete on public.memberships for delete to authenticated
  using (org_id in (select app.owner_org_ids()));

-- ---------------------------------------------------------------- locations
alter table public.locations enable row level security;
revoke all on public.locations from anon, authenticated;
grant select on public.locations to authenticated;
grant insert (id, org_id, name, address, eircode, timezone, receipt_footer) on public.locations to authenticated;
grant update (name, address, eircode, timezone, receipt_footer) on public.locations to authenticated;
grant delete on public.locations to authenticated;

create policy locations_select on public.locations for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy locations_insert on public.locations for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy locations_update on public.locations for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));
create policy locations_delete on public.locations for delete to authenticated
  using (org_id in (select app.owner_org_ids()));

-- ---------------------------------------------------------------- registers
-- device_token_hash is server-only. Pairing fields are set by the server.
alter table public.registers enable row level security;
revoke all on public.registers from anon, authenticated;
grant select (id, org_id, location_id, name, paired_at, last_seen_at, created_at, updated_at) on public.registers to authenticated;
grant insert (id, org_id, location_id, name) on public.registers to authenticated;
grant update (name, location_id) on public.registers to authenticated;
grant delete on public.registers to authenticated;

create policy registers_select on public.registers for select to authenticated
  using (org_id in (select app.current_org_ids()));
create policy registers_insert on public.registers for insert to authenticated
  with check (org_id in (select app.manager_org_ids()));
create policy registers_update on public.registers for update to authenticated
  using (org_id in (select app.manager_org_ids()))
  with check (org_id in (select app.manager_org_ids()));
create policy registers_delete on public.registers for delete to authenticated
  using (org_id in (select app.manager_org_ids()));

-- ---------------------------------------------------------------- tax_rates
-- Global reference data: any signed-in user can read; nobody writes except migrations.
alter table public.tax_rates enable row level security;
revoke all on public.tax_rates from anon, authenticated;
revoke insert, update, delete, truncate on public.tax_rates from service_role;
grant select on public.tax_rates to authenticated;

create policy tax_rates_select on public.tax_rates for select to authenticated
  using (true);

-- ---------------------------------------------------------------- audit_log (append-only)
alter table public.audit_log enable row level security;
revoke all on public.audit_log from public, anon, authenticated;
revoke update, delete, truncate on public.audit_log from service_role;
grant select on public.audit_log to authenticated;
grant insert (id, org_id, actor_user_id, action, entity, entity_id, before, after, ip)
  on public.audit_log to authenticated;

create policy audit_log_select on public.audit_log for select to authenticated
  using (org_id in (select app.manager_org_ids()));
-- Members can only append entries in their own org, attributed to themselves.
create policy audit_log_insert on public.audit_log for insert to authenticated
  with check (
    org_id in (select app.current_org_ids())
    and actor_user_id = (select app.current_user_id())
  );

-- Defence in depth: blocks even the table owner and any future GRANT slip.
create function app.audit_log_reject_change() returns trigger
language plpgsql
as $$ begin raise exception 'audit_log is append-only' using errcode = '42501'; end $$;

create trigger audit_log_no_row_change before update or delete on public.audit_log
  for each row execute function app.audit_log_reject_change();
create trigger audit_log_no_truncate before truncate on public.audit_log
  for each statement execute function app.audit_log_reject_change();
