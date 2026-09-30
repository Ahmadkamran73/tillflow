-- Hand-written: sign-up provisioning.
-- A signed-in user with no membership creates their organisation and becomes its owner, in one
-- transaction, without the service-role key ever being reachable from a user request.
-- The caller can only ever provision for themselves (app.current_user_id()), never for another user id.

create function public.create_my_organisation(p_org_id uuid, p_membership_id uuid, p_audit_id uuid, p_name text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_name text := btrim(coalesce(p_name, ''));
  v_existing uuid;
begin
  if v_user is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_org_id is null or p_membership_id is null or p_audit_id is null then
    raise exception 'ids are required' using errcode = '22023';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then
    raise exception 'organisation name must be 1 to 120 characters' using errcode = '22023';
  end if;

  -- Serialise concurrent first requests (double-click, two tabs) for the same user.
  perform pg_advisory_xact_lock(hashtextextended(v_user::text, 0));

  -- Idempotent: a user who already belongs to an organisation gets that one back, nothing is created.
  select m.org_id into v_existing
  from public.memberships m
  where m.user_id = v_user
  order by m.created_at
  limit 1;
  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.organisations (id, name, business_type) values (p_org_id, v_name, 'general');
  insert into public.memberships (id, org_id, user_id, role) values (p_membership_id, p_org_id, v_user, 'owner');
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (p_audit_id, p_org_id, v_user, 'organisation.created', 'organisation', p_org_id);

  return p_org_id;
end
$$;

revoke all on function public.create_my_organisation(uuid, uuid, uuid, text) from public, anon;
grant execute on function public.create_my_organisation(uuid, uuid, uuid, text) to authenticated;
