-- Hand-written: enforce two auth rules in the database, not only in Next.js.
--   1. Owners, and anyone with a verified authenticator (TOTP) factor, only get org access on an
--      aal2 session. A password, magic-link or recovery-link session (aal1) sees nothing, even if
--      it calls PostgREST directly with the public anon key.
--   2. A session created through an OAuth provider (Google) never carries cashier access.
-- Both live in app.org_ids_with_roles, the single membership lookup every policy already uses.
-- The only thing an aal1 session can still read is its OWN membership rows, so the app can tell
-- an owner "finish MFA" instead of "you have no organisation".

-- The only places that read auth-provider claims (like app.current_user_id for the user id).
create function app.current_aal() returns text
language sql stable set search_path = ''
as $$ select coalesce((select auth.jwt()) ->> 'aal', 'aal1') $$;

create function app.session_via_oauth() returns boolean
language sql stable set search_path = ''
as $$ select coalesce((select auth.jwt()) -> 'amr' @> '[{"method":"oauth"}]'::jsonb, false) $$;

revoke all on function app.current_aal() from public;
revoke all on function app.session_via_oauth() from public;
grant execute on function app.current_aal() to authenticated, service_role;
grant execute on function app.session_via_oauth() to authenticated, service_role;

create or replace function app.org_ids_with_roles(roles public.membership_role[]) returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.org_id from public.memberships m
  where m.user_id = (select app.current_user_id())
    and m.role = any (roles)
    and not (m.role = 'cashier' and (select app.session_via_oauth()))
    and (
      (select app.current_aal()) = 'aal2'
      or (
        m.role <> 'owner'
        and not exists (
          select 1 from auth.mfa_factors f
          where f.user_id = m.user_id and f.status = 'verified'
        )
      )
    )
$$;

-- A user can always read their own membership rows (id, org, role only: column grants still hide pin_hash).
create policy memberships_select_own on public.memberships for select to authenticated
  using (user_id = (select app.current_user_id()));
