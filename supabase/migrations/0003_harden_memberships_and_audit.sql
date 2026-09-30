-- Hand-written: follow-up to the tenant-isolation audit of 0001.
--  1. Memberships are created only by server code (invite/accept flow), never by a client INSERT.
--  2. audit_log rows are written only by server code, so a client cannot forge entries.
--  3. memberships.location_ids must reference locations of the same org.
--  4. An org can never be left without an owner (unless it is closed).
--  5. touch_updated_at pins search_path like the other app functions.

-- 1 + 2: no client INSERT (table-level revoke also removes the column-level grants).
drop policy memberships_insert on public.memberships;
revoke insert on public.memberships from authenticated;

drop policy audit_log_insert on public.audit_log;
revoke insert on public.audit_log from authenticated;

-- 3: location_ids has no FK (uuid[]), so enforce it here.
create function app.memberships_check_location_ids() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if cardinality(new.location_ids) > 0 and (
    select count(distinct l.id) from public.locations l
    where l.org_id = new.org_id and l.id = any (new.location_ids)
  ) <> (select count(distinct x) from unnest(new.location_ids) as x) then
    raise exception 'location_ids must all belong to the membership''s organisation'
      using errcode = '23514';
  end if;
  return new;
end
$$;

create trigger memberships_check_location_ids
  before insert or update of location_ids, org_id on public.memberships
  for each row execute function app.memberships_check_location_ids();

-- 4: keep at least one owner. Fires for every role, including service_role and the table owner.
create function app.memberships_keep_an_owner() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'owner'
     and (tg_op = 'DELETE' or new.role <> 'owner' or new.org_id <> old.org_id)
     and not exists (
       select 1 from public.memberships m
       where m.org_id = old.org_id and m.role = 'owner' and m.id <> old.id
     )
     and not exists (
       select 1 from public.organisations o where o.id = old.org_id and o.status = 'closed'
     )
  then
    raise exception 'an organisation must keep at least one owner' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end
$$;

create trigger memberships_keep_an_owner
  before update of role, org_id or delete on public.memberships
  for each row execute function app.memberships_keep_an_owner();

-- 5
create or replace function app.touch_updated_at() returns trigger
language plpgsql set search_path = ''
as $$ begin new.updated_at := now(); return new; end $$;
