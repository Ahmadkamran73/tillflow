-- Account export: the owner can delete a finished export file as soon as it is downloaded.
--
-- The ZIP can be large and sits in our database until it expires (7 days). public.delete_account_export
-- removes the file at once. The request row stays (status failed, code 'deleted') for the audit trail and
-- the "one export a day" rule: a deleted export still counts for that day, otherwise request-and-delete
-- could be repeated all day to make the server build the ZIP again and again. Owner only; an audit row
-- with ids only is written.

create function public.delete_account_export(p_org uuid, p_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_org not in (select app.owner_org_ids()) then
    raise exception 'owners only' using errcode = '42501';
  end if;
  perform 1 from public.account_exports e
   where e.org_id = p_org and e.id = p_id and e.status = 'ready' for update;
  if not found then
    raise exception 'export not available' using errcode = '22023';
  end if;
  delete from public.account_export_files where org_id = p_org and export_id = p_id;
  update public.account_exports set status = 'failed', error_code = 'deleted'
   where org_id = p_org and id = p_id;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, (select app.current_user_id()), 'account.export_deleted',
          'account_export', p_id);
end
$$;
revoke all on function public.delete_account_export(uuid, uuid) from public, anon;
grant execute on function public.delete_account_export(uuid, uuid) to authenticated;

-- request_account_export, as in 0051, except that a deleted export still counts for the day.
create or replace function public.request_account_export(p_org uuid, p_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_org not in (select app.owner_org_ids()) then
    raise exception 'owners only' using errcode = '42501';
  end if;
  if not (select app.recent_auth(600)) then
    raise exception 'confirm your identity again' using errcode = 'TF003';
  end if;
  -- Two requests at once must not both pass the "one a day" check.
  perform pg_advisory_xact_lock(hashtextextended('account_export:' || p_org::text, 0));
  if exists (
    select 1 from public.account_exports e
     where e.org_id = p_org and e.requested_at > now() - interval '24 hours'
       and (e.status in ('running', 'ready')
            or (e.status = 'failed' and e.error_code = 'deleted')
            or (e.status = 'queued' and e.requested_at > now() - interval '15 minutes'))
  ) then
    raise exception 'one export a day' using errcode = 'TF002';
  end if;
  insert into public.account_exports (id, org_id, requested_by)
  values (p_id, p_org, (select app.current_user_id()));
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, (select app.current_user_id()), 'account.export_requested',
          'account_export', p_id);
end
$$;
