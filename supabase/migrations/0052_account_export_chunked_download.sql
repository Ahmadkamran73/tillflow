-- Account export: download the ZIP in slices.
--
-- Found on staging (2026-10-16): a 21.8 MB export built fine, but public.get_account_export returns
-- the whole file in one call, as hex (about 44 MB) through the API, and the database refused it with
-- "canceling statement due to statement timeout" (the hosted API roles have a short statement
-- timeout; the local database has none, so no local test saw it). The route now asks for the file
-- in slices of at most 2 MB with get_account_export_chunk. Same checks as get_account_export on
-- every slice (owner of the shop, sign-in proof from the last 10 minutes, ready and not expired);
-- an audit row is written for the first slice a person asks for in any 10 minutes. get_account_export stays as it was.
--
-- The file column is stored uncompressed out of line (a ZIP does not compress), so a slice is read
-- without unpacking the whole value. This applies to files stored from now on.

alter table public.account_export_files alter column bytes set storage external;

create function public.get_account_export_chunk(p_org uuid, p_id uuid, p_offset integer, p_length integer)
returns bytea
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_chunk bytea;
begin
  if p_offset is null or p_length is null or p_offset < 0 or p_offset > 1000000000 or p_length < 1 or p_length > 2097152 then
    raise exception 'bad slice' using errcode = '22023';
  end if;
  if p_org not in (select app.owner_org_ids()) then
    raise exception 'owners only' using errcode = '42501';
  end if;
  if not (select app.recent_auth(600)) then
    raise exception 'confirm your identity again' using errcode = 'TF003';
  end if;
  select substring(f.bytes from p_offset + 1 for p_length) into v_chunk
    from public.account_exports e
    join public.account_export_files f on f.org_id = e.org_id and f.export_id = e.id
   where e.org_id = p_org and e.id = p_id and e.status = 'ready' and e.expires_at > now();
  if v_chunk is null or length(v_chunk) = 0 then
    raise exception 'export not available' using errcode = '22023';
  end if;
  -- One audit row per person and export per 10 minutes (the sign-in proof window), whichever slice
  -- is asked for first, so a caller cannot read the file without a trace by skipping slice 0.
  if not exists (
    select 1 from public.audit_log
     where org_id = p_org and entity_id = p_id and action = 'account.export_downloaded'
       and actor_user_id = (select app.current_user_id())
       and created_at > now() - interval '10 minutes') then
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
    values (gen_random_uuid(), p_org, (select app.current_user_id()), 'account.export_downloaded',
            'account_export', p_id);
  end if;
  return v_chunk;
end
$$;
revoke all on function public.get_account_export_chunk(uuid, uuid, integer, integer) from public, anon;
grant execute on function public.get_account_export_chunk(uuid, uuid, integer, integer) to authenticated;
