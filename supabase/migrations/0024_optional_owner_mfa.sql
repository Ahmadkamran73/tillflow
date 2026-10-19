-- Hand-written: two-step verification (TOTP) is now optional for owners.
-- Until now an owner needed an aal2 session even with no authenticator. Now the rule is the same
-- for every role: once a user has a VERIFIED authenticator factor, only an aal2 session gets org
-- access; a user who never set one up works at aal1 and the app keeps reminding them to.
-- Everything that checks owner or manager rights goes through app.org_ids_with_roles, so every
-- policy and SECURITY DEFINER function follows this change. The OAuth cashier rule is unchanged.
create or replace function app.org_ids_with_roles(roles public.membership_role[]) returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.org_id from public.memberships m
  where m.user_id = (select app.current_user_id())
    and m.role = any (roles)
    and not (m.role = 'cashier' and (select app.session_via_oauth()))
    and (
      (select app.current_aal()) = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = m.user_id and f.status = 'verified'
      )
    )
$$;
