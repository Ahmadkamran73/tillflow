-- Hand-written: the whole-account export (GDPR portability) for owners. 0050 made the tables.
--
-- An owner asks for it once a day (public.request_account_export); a pg-boss job builds a ZIP of CSV
-- files by reading allow-listed tables page by page through ops.account_export_rows, stores it in
-- account_export_files (no client can read that table) and emails the requester a link to a page that
-- needs a signed-in owner (aal2 where they have two-step verification). The file is handed over only
-- by public.get_account_export, which checks owner, shop and expiry again and writes an audit row.
-- Files are deleted after 7 days. Audit rows carry ids only, never names or amounts.
--
-- Fresh authentication: both public functions also need the caller to have proved who they are in
-- the last 10 minutes (app.recent_auth): a fresh authenticator code for anyone who has two-step
-- verification (their session is aal2), a fresh password sign-in for anyone who has not. A stolen
-- session cookie or an old magic link is not enough. The app sends the owner to a confirm page on
-- TF003. Every owner is emailed when an export is requested (ops.account_export_owner_emails); the
-- ZIP is never attached to any email.

-- ---------------------------------------------------------------- app.recent_auth
-- True when the JWT carries a sign-in proof of the right kind, made in the last p_seconds: a TOTP
-- proof when the session is aal2, a password proof otherwise (magic links and OAuth never count).
create function app.recent_auth(p_seconds int default 600) returns boolean
language sql stable set search_path = ''
as $$
  select exists (
    select 1
      from jsonb_array_elements(coalesce((select auth.jwt()) -> 'amr', '[]'::jsonb)) a
     where a ->> 'method' = case when (select app.current_aal()) = 'aal2' then 'totp' else 'password' end
       and (a ->> 'timestamp') ~ '^[0-9]{1,12}$'
       and (a ->> 'timestamp')::bigint > extract(epoch from now())::bigint - p_seconds)
$$;
revoke all on function app.recent_auth(int) from public;
grant execute on function app.recent_auth(int) to authenticated, service_role;

-- ---------------------------------------------------------------- RLS
alter table public.account_exports enable row level security;
revoke all on public.account_exports from anon, authenticated;
grant select (id, org_id, requested_by, status, file_name, size_bytes, error_code, requested_at, ready_at, expires_at)
  on public.account_exports to authenticated;
create policy account_exports_select on public.account_exports for select to authenticated
  using (org_id in (select app.owner_org_ids()));

alter table public.account_export_files enable row level security;
revoke all on public.account_export_files from anon, authenticated;
create policy account_export_files_deny_all on public.account_export_files as restrictive for all
  to anon, authenticated using (false) with check (false);

-- ---------------------------------------------------------------- public.request_account_export
-- Owner only, one per 24 hours (a request that never started within 15 minutes, or failed, does not
-- count, so a lost job cannot lock the owner out).
create function public.request_account_export(p_org uuid, p_id uuid) returns void
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
revoke all on function public.request_account_export(uuid, uuid) from public, anon;
grant execute on function public.request_account_export(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- public.get_account_export
-- The ZIP, once ready and not expired, to an owner of that shop. Audit-logged on every download.
create function public.get_account_export(p_org uuid, p_id uuid) returns bytea
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_bytes bytea;
begin
  if p_org not in (select app.owner_org_ids()) then
    raise exception 'owners only' using errcode = '42501';
  end if;
  if not (select app.recent_auth(600)) then
    raise exception 'confirm your identity again' using errcode = 'TF003';
  end if;
  select f.bytes into v_bytes
    from public.account_exports e
    join public.account_export_files f on f.org_id = e.org_id and f.export_id = e.id
   where e.org_id = p_org and e.id = p_id and e.status = 'ready' and e.expires_at > now();
  if v_bytes is null then
    raise exception 'export not available' using errcode = '22023';
  end if;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, (select app.current_user_id()), 'account.export_downloaded',
          'account_export', p_id);
  return v_bytes;
end
$$;
revoke all on function public.get_account_export(uuid, uuid) from public, anon;
grant execute on function public.get_account_export(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- ops.account_export_begin
-- Marks a queued (or interrupted) export as running and says whose it is; null when there is
-- nothing to do (unknown, finished, or expired).
create function ops.account_export_begin(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  e public.account_exports;
begin
  select * into e from public.account_exports where id = p_id for update;
  if not found or e.status not in ('queued', 'running') then
    return null;
  end if;
  update public.account_exports set status = 'running' where id = p_id;
  return jsonb_build_object('org_id', e.org_id, 'org_name',
    (select o.name from public.organisations o where o.id = e.org_id));
end
$$;
revoke all on function ops.account_export_begin(uuid) from public, anon, authenticated;
grant execute on function ops.account_export_begin(uuid) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.account_export_rows
-- A page of one allow-listed table of the export's shop, as a JSON array. Secrets never leave:
-- PIN hashes and lockout counters, device token hashes. Only for a running export.
create function ops.account_export_rows(p_id uuid, p_table text, p_offset int, p_limit int)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_org uuid;
  v_hide text[] := '{}';
  v_out jsonb;
begin
  select e.org_id into v_org from public.account_exports e where e.id = p_id and e.status = 'running';
  if v_org is null then
    raise exception 'export not running' using errcode = '22023';
  end if;
  if p_table not in ('locations', 'registers', 'memberships', 'tender_types', 'categories', 'products',
      'variants', 'variant_costs', 'customers', 'suppliers', 'sales', 'sale_lines', 'payments', 'refunds',
      'refund_lines', 'refund_payments', 'stock_movements', 'shifts', 'shift_closes', 'cash_movements') then
    raise exception 'unknown table' using errcode = '22023';
  end if;
  if p_offset < 0 or p_limit not between 1 and 10000 then
    raise exception 'bad page' using errcode = '22023';
  end if;
  if p_table = 'registers' then
    v_hide := array['device_token_hash'];
  elsif p_table = 'memberships' then
    v_hide := array['pin_hash', 'pin_set_at', 'pin_failed_count', 'pin_locked_until'];
  end if;
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t) - $1), ''[]''::jsonb)
       from (select * from public.%I where org_id = $2 order by %I offset $3 limit $4) t', p_table,
    case when p_table = 'variant_costs' then 'variant_id' else 'id' end)
    into v_out using v_hide, v_org, p_offset, p_limit;
  return v_out;
end
$$;
revoke all on function ops.account_export_rows(uuid, text, int, int) from public, anon, authenticated;
grant execute on function ops.account_export_rows(uuid, text, int, int) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.account_export_finish / fail
create function ops.account_export_finish(p_id uuid, p_file_name text, p_bytes bytea) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid;
begin
  select e.org_id into v_org from public.account_exports e where e.id = p_id and e.status = 'running';
  if v_org is null then
    raise exception 'export not running' using errcode = '22023';
  end if;
  insert into public.account_export_files (export_id, org_id, bytes) values (p_id, v_org, p_bytes)
  on conflict (export_id) do update set bytes = excluded.bytes;
  update public.account_exports
     set status = 'ready', file_name = p_file_name, size_bytes = octet_length(p_bytes),
         ready_at = now(), expires_at = now() + interval '7 days', error_code = null
   where id = p_id;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  select gen_random_uuid(), e.org_id, e.requested_by, 'account.export_ready', 'account_export', e.id
    from public.account_exports e where e.id = p_id;
end
$$;
revoke all on function ops.account_export_finish(uuid, text, bytea) from public, anon, authenticated;
grant execute on function ops.account_export_finish(uuid, text, bytea) to service_role, tillflow_ops;

create function ops.account_export_fail(p_id uuid, p_code text) returns void
language sql volatile security definer set search_path = ''
as $$
  update public.account_exports
     set status = 'failed', error_code = left(coalesce(p_code, 'failed'), 40)
   where id = p_id and status in ('queued', 'running');
$$;
revoke all on function ops.account_export_fail(uuid, text) from public, anon, authenticated;
grant execute on function ops.account_export_fail(uuid, text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.account_export_mail_data
-- Who to tell: the owner who asked. Like ops.shift_z_email_data this reads the login account's
-- address (auth.users) inside the ops layer: a swap point if the auth provider changes.
create function ops.account_export_mail_data(p_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'org_id', e.org_id,
    'org_name', o.name,
    'file_name', e.file_name,
    'size_bytes', e.size_bytes,
    'expires_at', e.expires_at,
    'email', (select lower(u.email) from auth.users u where u.id = e.requested_by))
    from public.account_exports e
    join public.organisations o on o.id = e.org_id
   where e.id = p_id and e.status = 'ready';
$$;
revoke all on function ops.account_export_mail_data(uuid) from public, anon, authenticated;
grant execute on function ops.account_export_mail_data(uuid) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.account_export_owner_emails
-- Every owner of the shop, to be told that an export was requested (not who asked, not the file).
create function ops.account_export_owner_emails(p_id uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'org_id', e.org_id,
    'org_name', o.name,
    'requested_at', e.requested_at,
    'emails', coalesce((
      select jsonb_agg(distinct lower(u.email))
        from public.memberships m
        join auth.users u on u.id = m.user_id
       where m.org_id = e.org_id and m.role = 'owner' and u.email is not null), '[]'::jsonb))
    from public.account_exports e
    join public.organisations o on o.id = e.org_id
   where e.id = p_id;
$$;
revoke all on function ops.account_export_owner_emails(uuid) from public, anon, authenticated;
grant execute on function ops.account_export_owner_emails(uuid) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.account_export_purge
-- Deletes finished files after their 7 days and request rows a month after that.
create function ops.account_export_purge() returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_n int;
begin
  delete from public.account_export_files f
   using public.account_exports e
   where e.org_id = f.org_id and e.id = f.export_id and e.expires_at < now();
  get diagnostics v_n = row_count;
  update public.account_exports set status = 'failed', error_code = 'expired'
   where status = 'ready' and expires_at < now();
  update public.account_exports set status = 'failed', error_code = 'stuck'
   where status in ('queued', 'running') and requested_at < now() - interval '1 day';
  delete from public.account_exports where requested_at < now() - interval '37 days';
  return v_n;
end
$$;
revoke all on function ops.account_export_purge() from public, anon, authenticated;
grant execute on function ops.account_export_purge() to service_role, tillflow_ops;
