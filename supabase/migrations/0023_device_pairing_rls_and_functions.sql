-- Hand-written (step 1.7): register pairing, device tokens, cashier PINs, manager override.
--
-- Manager approvals: a till cannot claim that a manager approved something. The server checks the
-- manager's PIN (ops.pin_attempt_*) and then issues a single-use row in register_approvals
-- (ops.issue_approval). A sale or event carries only that row's id; ops.record_sale and
-- ops.record_register_events DERIVE the approver from it. Approvals made offline cannot be verified:
-- such a sale is held for a manager (Try again in the back office) and such an event is logged as
-- unverified, never as approved by anyone.
--
-- Model: a paired till holds ONLY a device token (no Supabase session). The server stores the
-- token's SHA-256 hash on registers.device_token_hash. Everything a till does goes through the
-- privileged ops.* functions below, each of which resolves org + register from the token hash
-- (app.device_register) and never trusts an org or register id sent by the till.
--
-- Back-office functions (public.*) run as the signed-in manager/owner (SECURITY DEFINER, role
-- checked through the app.* helper family, every one writes audit_log). PIN hashes are never
-- readable by clients and never written to audit_log.

-- ---------------------------------------------------------------- column grants (memberships)
-- The till's name, whether a PIN is set and until when it is locked are fine to show to members.
-- pin_hash and pin_failed_count stay unreadable and unwritable for every client role.
grant select (display_name, pin_set_at, pin_locked_until) on public.memberships to authenticated;

-- ---------------------------------------------------------------- registers: one token, one till
create unique index registers_device_token_hash_key on public.registers (device_token_hash)
  where device_token_hash is not null;

-- ---------------------------------------------------------------- register_pairing_codes
alter table public.register_pairing_codes enable row level security;
revoke all on public.register_pairing_codes from anon, authenticated;
-- code_hash is never readable; the code itself is shown once, when it is created.
grant select (id, org_id, register_id, expires_at, used_at, created_at)
  on public.register_pairing_codes to authenticated;
create policy register_pairing_codes_select on public.register_pairing_codes
  for select to authenticated
  using (org_id in (select app.manager_org_ids()));
-- No insert/update/delete policy: only the functions below write to this table.

-- Approvals are server-issued proofs; managers may read them (who approved what), nobody writes them.
alter table public.register_approvals enable row level security;
revoke all on public.register_approvals from anon, authenticated;
grant select on public.register_approvals to authenticated;
create policy register_approvals_select on public.register_approvals
  for select to authenticated
  using (org_id in (select app.manager_org_ids()));

-- ---------------------------------------------------------------- app helpers
-- The ONE place a device token is looked up. Closed organisations get nothing.
create function app.device_register(p_token_hash text)
returns table (org_id uuid, register_id uuid, location_id uuid)
language sql stable security definer set search_path = ''
as $$
  select r.org_id, r.id, r.location_id
  from public.registers r
  join public.organisations o on o.id = r.org_id
  where p_token_hash is not null
    and r.device_token_hash = p_token_hash
    and o.status <> 'closed'
$$;
revoke all on function app.device_register(text) from public, anon, authenticated;
grant execute on function app.device_register(text) to service_role, tillflow_ops;

-- Manager or owner of this org (the approver of an override). Like app.is_member, for ops.*.
create function app.is_manager(p_user uuid, p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = p_user and m.role in ('owner', 'manager')
  )
$$;
revoke all on function app.is_manager(uuid, uuid) from public, anon, authenticated;
grant execute on function app.is_manager(uuid, uuid) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- public.create_pairing_code
-- A manager asks for a one-time code for a till. The app generates the 8-character code, shows it
-- once and passes only its SHA-256 hash. Earlier unused codes for the till stop working.
create function public.create_pairing_code(p_register uuid, p_code_hash text, p_audit_id uuid)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_org uuid;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  select org_id into v_org from public.registers where id = p_register;
  if v_user is null or v_org is null or p_audit_id is null
     or not exists (select 1 from app.manager_org_ids() o where o = v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_code_hash is null or p_code_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'bad code hash' using errcode = '22023';
  end if;

  update public.register_pairing_codes
     set expires_at = least(expires_at, now())
   where register_id = p_register and used_at is null and expires_at > now();

  insert into public.register_pairing_codes (id, org_id, register_id, code_hash, expires_at, created_by)
  values (gen_random_uuid(), v_org, p_register, p_code_hash, v_expires, v_user);

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (p_audit_id, v_org, v_user, 'register.pairing_code_created', 'register', p_register,
          jsonb_build_object('expires_at', v_expires));
  return v_expires;
end
$$;
revoke all on function public.create_pairing_code(uuid, text, uuid) from public, anon;
grant execute on function public.create_pairing_code(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------- public.revoke_register
-- Unpairs a till: its token stops working at once and open codes are voided. Sales still waiting
-- on the device are kept there and sync after the till is paired again.
create function public.revoke_register(p_register uuid, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_org uuid;
begin
  select org_id into v_org from public.registers where id = p_register for update;
  if v_user is null or v_org is null or p_audit_id is null
     or not exists (select 1 from app.manager_org_ids() o where o = v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.registers
     set device_token_hash = null, paired_at = null
   where id = p_register;
  update public.register_pairing_codes
     set expires_at = least(expires_at, now())
   where register_id = p_register and used_at is null and expires_at > now();

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (p_audit_id, v_org, v_user, 'register.revoked', 'register', p_register);
end
$$;
revoke all on function public.revoke_register(uuid, uuid) from public, anon;
grant execute on function public.revoke_register(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- PINs
-- p_hash is an Argon2id PHC string computed by the app; the plain PIN never reaches the database.
create function public.set_my_pin_hash(p_org uuid, p_hash text, p_display_name text, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_name text := btrim(p_display_name);
  v_params text[];
begin
  if v_user is null or p_org is null or p_audit_id is null
     or not exists (select 1 from app.current_org_ids() o where o = p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- Only Argon2id at the agreed cost or stronger (m >= 19 MiB, t >= 2): a member cannot store a
  -- trivially cheap hash that every till would then hold.
  v_params := regexp_match(p_hash, '^\$argon2id\$v=19\$m=(\d{1,8}),t=(\d{1,4}),p=(\d{1,2})\$');
  if p_hash is null or char_length(p_hash) > 300 or v_params is null
     or v_params[1]::bigint < 19456 or v_params[2]::int < 2 or v_params[3]::int < 1
     or v_name is null or char_length(v_name) not between 1 and 40 then
    raise exception 'bad input' using errcode = '22023';
  end if;

  update public.memberships
     set pin_hash = p_hash, display_name = v_name, pin_set_at = now(),
         pin_failed_count = 0, pin_locked_until = null
   where org_id = p_org and user_id = v_user;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (p_audit_id, p_org, v_user, 'staff.pin_set', 'membership', v_user);
end
$$;
revoke all on function public.set_my_pin_hash(uuid, text, text, uuid) from public, anon;
grant execute on function public.set_my_pin_hash(uuid, text, text, uuid) to authenticated;

-- A manager clears a cashier's PIN (forgotten or locked); an owner can clear anyone's.
create function public.reset_member_pin(p_membership uuid, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_org uuid;
  v_target uuid;
  v_role public.membership_role;
begin
  select org_id, user_id, role into v_org, v_target, v_role
    from public.memberships where id = p_membership for update;
  if v_user is null or v_org is null or p_audit_id is null
     or not exists (select 1 from app.manager_org_ids() o where o = v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- Managers reset cashiers only; owners and other managers need an owner.
  if v_role <> 'cashier' and not exists (select 1 from app.owner_org_ids() o where o = v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  update public.memberships
     set pin_hash = null, pin_set_at = null, pin_failed_count = 0, pin_locked_until = null
   where id = p_membership;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (p_audit_id, v_org, v_user, 'staff.pin_reset', 'membership', v_target);
end
$$;
revoke all on function public.reset_member_pin(uuid, uuid) from public, anon;
grant execute on function public.reset_member_pin(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- discount threshold
create function public.set_discount_override(p_org uuid, p_bp integer, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_before integer;
begin
  if v_user is null or p_org is null or p_audit_id is null
     or not exists (select 1 from app.owner_org_ids() o where o = p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_bp is null or p_bp not between 0 and 10000 then
    raise exception 'bad input' using errcode = '22023';
  end if;

  select discount_override_bp into v_before from public.organisations where id = p_org for update;
  update public.organisations set discount_override_bp = p_bp where id = p_org;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, before, after)
  values (p_audit_id, p_org, v_user, 'organisation.discount_override_changed', 'organisation', p_org,
          jsonb_build_object('bp', v_before), jsonb_build_object('bp', p_bp));
end
$$;
revoke all on function public.set_discount_override(uuid, integer, uuid) from public, anon;
grant execute on function public.set_discount_override(uuid, integer, uuid) to authenticated;

-- ================================================================ ops.* (the till's side)
-- Callable only by the privileged connection (src/lib/ops/db.ts).

-- ---------------------------------------------------------------- ops.pair_register
-- Exchanges a pairing code for a device token (the app made the token; only its hash arrives).
-- Returns the org and register, or no row when the code is unknown, used or expired (the caller
-- cannot tell which). Pairing again replaces the old token, so the old device stops working.
create function ops.pair_register(p_code_hash text, p_token_hash text)
returns table (org_id uuid, register_id uuid)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c public.register_pairing_codes%rowtype;
begin
  if p_code_hash is null or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    return;
  end if;
  select * into c from public.register_pairing_codes
   where code_hash = p_code_hash for update;
  if not found or c.used_at is not null or c.expires_at <= now() then
    return;
  end if;

  update public.register_pairing_codes set used_at = now() where id = c.id;
  update public.registers
     set device_token_hash = p_token_hash, paired_at = now(), last_seen_at = now()
   where registers.id = c.register_id and registers.org_id = c.org_id;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), c.org_id, c.created_by, 'register.paired', 'register', c.register_id);

  org_id := c.org_id;
  register_id := c.register_id;
  return next;
end
$$;

-- ---------------------------------------------------------------- ops.device_auth
-- Who is this token? Also the till's heartbeat (last_seen_at, at most every 30 s).
create function ops.device_auth(p_token_hash text)
returns table (org_id uuid, register_id uuid, location_id uuid)
language plpgsql volatile security definer set search_path = ''
as $$
begin
  return query select d.org_id, d.register_id, d.location_id from app.device_register(p_token_hash) d;
  update public.registers r
     set last_seen_at = now()
   where r.device_token_hash = p_token_hash
     and (r.last_seen_at is null or r.last_seen_at < now() - interval '30 seconds');
end
$$;

-- ---------------------------------------------------------------- ops.device_feed_meta
-- Everything small that the till needs besides the catalogue tables: the shop's header, its own
-- till (with the last receipt number the server holds), tax rates, the staff picker.
-- staff carries each member's Argon2 PIN hash so a till can check a PIN offline.
create function ops.device_feed_meta(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
  v_loc record;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  select l.id, l.timezone, l.address, l.eircode, l.receipt_footer into v_loc
    from public.locations l where l.org_id = d.org_id and l.id = d.location_id;

  return jsonb_build_object(
    'org', (select jsonb_build_object(
        'business_type', o.business_type, 'name', o.name, 'legal_name', o.legal_name,
        'vat_number', o.vat_number, 'discount_override_bp', o.discount_override_bp)
      from public.organisations o where o.id = d.org_id),
    'location', jsonb_build_object(
        'id', v_loc.id, 'timezone', v_loc.timezone, 'address', v_loc.address,
        'eircode', v_loc.eircode, 'receipt_footer', v_loc.receipt_footer),
    'register', jsonb_build_object(
        'id', d.register_id,
        'name', (select r.name from public.registers r where r.id = d.register_id),
        'last_seq', coalesce((select max(s.receipt_seq) from public.sales s
                              where s.org_id = d.org_id and s.register_id = d.register_id), 0)),
    'tax_rates', coalesce((
        select jsonb_agg(jsonb_build_object('country', t.country, 'code', t.code, 'rate_bp', t.rate_bp,
                                            'valid_from', t.valid_from, 'valid_to', t.valid_to))
        from public.tax_rates t where t.country = 'IE'), '[]'::jsonb),
    'staff', coalesce((
        select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'display_name', m.display_name,
                                            'role', m.role, 'pin_hash', m.pin_hash) order by m.display_name)
        from public.memberships m
        where m.org_id = d.org_id and m.pin_hash is not null and m.display_name is not null), '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------- ops.device_sync_meta
-- What sale sync needs to re-price a sale for this till's shop, without a user session.
create function ops.device_sync_meta(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'timezone', (select l.timezone from public.locations l
                 where l.org_id = d.org_id and l.id = d.location_id),
    'discount_override_bp', (select o.discount_override_bp from public.organisations o
                             where o.id = d.org_id),
    'tax_rates', coalesce((
        select jsonb_agg(jsonb_build_object('country', t.country, 'code', t.code, 'rate_bp', t.rate_bp,
                                            'valid_from', t.valid_from, 'valid_to', t.valid_to))
        from public.tax_rates t where t.country = 'IE'), '[]'::jsonb)
  );
end
$$;

-- ---------------------------------------------------------------- ops.record_sync_rejection (replaced)
-- As in 0019, except that the person named on the sale need not be a member: the till is already
-- authenticated by its device token, and a sale naming an unknown cashier must become a rejection
-- a manager can see, not an error that blocks the queue behind it. The audit actor is the cashier
-- only when they really are a member.
create or replace function ops.record_sync_rejection(p jsonb) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_id uuid := (p ->> 'id')::uuid;
  v_reg uuid := (p ->> 'register_id')::uuid;
  v_user uuid := nullif(p ->> 'user_id', '')::uuid;
  v_inserted int;
begin
  if not exists (select 1 from public.registers r where r.id = v_reg and r.org_id = v_org) then
    raise exception 'unknown register' using errcode = '42501';
  end if;
  if exists (select 1 from public.sales where id = v_id) then
    return;
  end if;

  insert into public.sync_rejections (id, org_id, register_id, reason, detail, payload)
  values (v_id, v_org, v_reg, p ->> 'reason', coalesce(p -> 'detail', '{}'::jsonb), p -> 'payload')
  on conflict (id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (gen_random_uuid(), v_org,
            case when v_user is not null and app.is_member(v_user, v_org) then v_user end,
            'sale.sync_rejected', 'sale', v_id,
            jsonb_build_object('reason', p ->> 'reason', 'register_id', v_reg));
  end if;
end
$$;

-- ---------------------------------------------------------------- ops.device_feed_table
-- One page of one catalogue table, keyed by id (the till loops until a short page). Same columns
-- and "changed since" rule the session-based feed used. No cost prices.
create function ops.device_feed_table(
  p_token_hash text, p_table text, p_since timestamptz, p_after uuid, p_limit integer
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_after uuid := coalesce(p_after, '00000000-0000-0000-0000-000000000000'::uuid);
  v_out jsonb;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;

  if p_table = 'categories' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into v_out from (
      select c.id, c.name, c.colour, c.sort from public.categories c
      where c.org_id = d.org_id and c.id > v_after order by c.id limit v_limit) x;
  elsif p_table = 'products' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into v_out from (
      select p.id, p.name, p.category_id, p.tax_category, p.takeaway_tax_category, p.archived_at
      from public.products p
      where p.org_id = d.org_id and p.id > v_after
        and (case when p_since is null then p.archived_at is null else p.updated_at > p_since end)
      order by p.id limit v_limit) x;
  elsif p_table = 'variants' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into v_out from (
      select v.id, v.product_id, v.name, v.sku, v.barcode, v.price_incl_vat_cents, v.sort,
             v.attributes, v.archived_at
      from public.variants v
      where v.org_id = d.org_id and v.id > v_after
        and (case when p_since is null then v.archived_at is null else v.updated_at > p_since end)
      order by v.id limit v_limit) x;
  elsif p_table = 'modifier_groups' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into v_out from (
      select g.id, g.name, g.min_choices, g.max_choices, g.sort from public.modifier_groups g
      where g.org_id = d.org_id and g.id > v_after order by g.id limit v_limit) x;
  elsif p_table = 'modifiers' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into v_out from (
      select m.id, m.group_id, m.name, m.price_delta_cents, m.sort from public.modifiers m
      where m.org_id = d.org_id and m.id > v_after order by m.id limit v_limit) x;
  elsif p_table = 'product_modifier_groups' then
    select coalesce(jsonb_agg(to_jsonb(x) order by x.id), '[]'::jsonb) into v_out from (
      select g.id, g.product_id, g.group_id, g.sort from public.product_modifier_groups g
      where g.org_id = d.org_id and g.id > v_after order by g.id limit v_limit) x;
  else
    raise exception 'unknown table' using errcode = '22023';
  end if;
  return v_out;
end
$$;

-- ---------------------------------------------------------------- ops.device_sale_catalog_as_of
-- The catalogue as it stood at p_at, for the org the token belongs to.
create function ops.device_sale_catalog_as_of(
  p_token_hash text, p_variant_ids uuid[], p_modifier_ids uuid[], p_at timestamptz
) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  return public.sale_catalog_as_of(d.org_id, p_variant_ids, p_modifier_ids, p_at);
end
$$;

-- Which of these sale ids the shop already has (replays are recognised as duplicates).
create function ops.device_sales_known(p_token_hash text, p_ids uuid[]) returns setof uuid
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return;
  end if;
  return query select s.id from public.sales s where s.org_id = d.org_id and s.id = any (p_ids);
end
$$;

-- ---------------------------------------------------------------- ops.issue_approval
-- Called by the unlock route right after a manager's PIN was verified for an override. Returns the
-- id the till attaches to ONE sale (purpose discount) or event (no_sale, refund). The caller has
-- already proved the PIN; this re-checks that the person is a manager or owner of the till's shop.
create function ops.issue_approval(p_token_hash text, p_user uuid, p_purpose text) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  v_id uuid := gen_random_uuid();
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    raise exception 'unknown device' using errcode = '42501';
  end if;
  if p_purpose is null or p_purpose not in ('discount', 'no_sale', 'refund') then
    raise exception 'bad purpose' using errcode = '22023';
  end if;
  if not app.is_manager(p_user, d.org_id) then
    raise exception 'not a manager' using errcode = '42501';
  end if;
  insert into public.register_approvals (id, org_id, register_id, approver_user_id, purpose)
  values (v_id, d.org_id, d.register_id, p_user, p_purpose);
  return v_id;
end
$$;

-- ---------------------------------------------------------------- PIN attempts
-- begin RESERVES an attempt before the PIN is checked, so parallel guesses cannot beat the limit:
-- the 6th concurrent begin finds the counter at 5 and is refused. finish records the outcome.
-- status: ok (go ahead and verify) | locked | no_pin. A manager approving an override and a
-- cashier unlocking share this counter.
create function ops.pin_attempt_begin(p_token_hash text, p_user uuid)
returns table (status text, pin_hash text, role public.membership_role, locked_until timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  m public.memberships%rowtype;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    raise exception 'unknown device' using errcode = '42501';
  end if;
  select * into m from public.memberships mm
   where mm.org_id = d.org_id and mm.user_id = p_user for update;
  if not found or m.pin_hash is null then
    status := 'no_pin';
    return next;
    return;
  end if;

  if m.pin_locked_until is not null and m.pin_locked_until > now() then
    status := 'locked';
    locked_until := m.pin_locked_until;
    return next;
    return;
  end if;
  -- A lock that has run out starts a fresh count.
  if m.pin_locked_until is not null then
    update public.memberships set pin_failed_count = 0, pin_locked_until = null where id = m.id;
    m.pin_failed_count := 0;
  end if;

  if m.pin_failed_count >= 5 then
    -- Five reserved attempts already: lock now (the finish calls may still be in flight).
    update public.memberships set pin_locked_until = now() + interval '15 minutes' where id = m.id
      returning memberships.pin_locked_until into locked_until;
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
    values (gen_random_uuid(), d.org_id, null, 'staff.pin_locked', 'membership', p_user);
    status := 'locked';
    return next;
    return;
  end if;

  update public.memberships set pin_failed_count = pin_failed_count + 1 where id = m.id;
  status := 'ok';
  pin_hash := m.pin_hash;
  role := m.role;
  return next;
end
$$;

create function ops.pin_attempt_finish(p_token_hash text, p_user uuid, p_ok boolean)
returns table (locked boolean, locked_until timestamptz)
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  m public.memberships%rowtype;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    raise exception 'unknown device' using errcode = '42501';
  end if;
  select * into m from public.memberships mm
   where mm.org_id = d.org_id and mm.user_id = p_user for update;
  if not found then
    locked := false;
    return next;
    return;
  end if;

  if p_ok then
    update public.memberships set pin_failed_count = 0, pin_locked_until = null where id = m.id;
    locked := false;
    return next;
    return;
  end if;

  if m.pin_failed_count >= 5 and (m.pin_locked_until is null or m.pin_locked_until <= now()) then
    update public.memberships set pin_locked_until = now() + interval '15 minutes' where id = m.id
      returning memberships.pin_locked_until into m.pin_locked_until;
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
    values (gen_random_uuid(), d.org_id, null, 'staff.pin_locked', 'membership', p_user);
  end if;
  locked := m.pin_locked_until is not null and m.pin_locked_until > now();
  locked_until := m.pin_locked_until;
  return next;
end
$$;

-- ---------------------------------------------------------------- ops.record_register_events
-- Drawer opens and refund approvals the till queued (offline included). p_events: [{id, kind,
-- at, cashier_user_id, approved_by, detail}]. kind: no_sale | refund_override. Both need an
-- approver who is a manager or owner of the shop. Idempotent on id (the audit row's own id), so
-- a replayed batch writes nothing twice. Returns the ids that are now recorded.
create function ops.record_register_events(p_token_hash text, p_events jsonb)
returns setof uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  e jsonb;
  v_id uuid;
  v_cashier uuid;
  v_approval uuid;
  v_claimed uuid;
  v_approver uuid;
  v_at timestamptz;
  v_kind text;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    raise exception 'unknown device' using errcode = '42501';
  end if;

  for e in select * from jsonb_array_elements(p_events) loop
    v_id := (e ->> 'id')::uuid;
    v_kind := e ->> 'kind';
    v_cashier := (e ->> 'cashier_user_id')::uuid;
    v_approval := nullif(e ->> 'approval_id', '')::uuid;
    v_claimed := nullif(e ->> 'claimed_approver', '')::uuid;
    v_at := (e ->> 'at')::timestamptz;
    if v_kind not in ('no_sale', 'refund_override') then
      raise exception 'unknown event kind' using errcode = '22023';
    end if;
    if not app.is_member(v_cashier, d.org_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;

    -- A replay: already recorded for this shop, nothing to do (the approval was spent the first time).
    if exists (select 1 from public.audit_log where id = v_id and org_id = d.org_id) then
      return next v_id;
      continue;
    end if;

    v_approver := null;
    if v_approval is not null then
      -- Verified: the approver is whoever the SERVER saw enter a manager PIN on this till.
      select a.approver_user_id into v_approver
        from public.register_approvals a
       where a.id = v_approval and a.org_id = d.org_id and a.register_id = d.register_id
         and a.purpose = case v_kind when 'no_sale' then 'no_sale' else 'refund' end
         and a.consumed_at is null
         and v_at between a.created_at - interval '1 minute' and a.created_at + interval '30 minutes'
       for update;
      if v_approver is null or not app.is_manager(v_approver, d.org_id) then
        raise exception 'approval not valid' using errcode = '42501';
      end if;
      update public.register_approvals set consumed_at = now(), consumed_for = v_id where id = v_approval;
    elsif v_claimed is not null and not app.is_manager(v_claimed, d.org_id) then
      raise exception 'not allowed' using errcode = '42501';
    end if;

    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (v_id, d.org_id, v_cashier,
            case v_kind when 'no_sale' then 'register.no_sale' else 'override.refund' end,
            'register', d.register_id,
            jsonb_build_object(
              'approval', case when v_approval is not null then 'pin_verified' else 'unverified_offline' end,
              'approved_by', v_approver,
              -- Offline the till cannot prove the PIN: the manager it names is a claim, labelled as one.
              'claimed_approver', case when v_approval is null then v_claimed end,
              'at', e ->> 'at',
              'detail', coalesce(e -> 'detail', '{}'::jsonb)))
    on conflict (id) do nothing;
    -- Only report ids that are recorded for THIS shop (a clashing id in another shop is not ours).
    if exists (select 1 from public.audit_log where id = v_id and org_id = d.org_id) then
      return next v_id;
    end if;
  end loop;
end
$$;

-- ---------------------------------------------------------------- ops.record_sale (replaced)
-- As in 0019, plus the manager override: s.approved_by (optional) must be a manager or owner of
-- the shop; the override is audited in the same transaction. The cashier (s.user_id) is whoever
-- unlocked the till with a PIN; the caller has already authenticated the device.
create or replace function ops.record_sale(p jsonb) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jsonb := p -> 'sale';
  v_org uuid := (s ->> 'org_id')::uuid;
  v_id uuid := (s ->> 'id')::uuid;
  v_reg uuid := (s ->> 'register_id')::uuid;
  v_user uuid := (s ->> 'user_id')::uuid;
  -- approved_by is for TRUSTED callers only (the back office re-running a held sale as a manager).
  -- A till never supplies it: it supplies approval_id, and the approver is derived from that.
  v_approver uuid := nullif(s ->> 'approved_by', '')::uuid;
  v_approval uuid := nullif(s ->> 'approval_id', '')::uuid;
  v_completed timestamptz := (s ->> 'completed_at')::timestamptz;
  v_loc uuid;
  v_inserted int;
  v_existing public.sales%rowtype;
begin
  if not app.is_member(v_user, v_org) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select r.location_id into v_loc from public.registers r where r.id = v_reg and r.org_id = v_org;
  if v_loc is null then
    raise exception 'unknown register' using errcode = '42501';
  end if;

  begin
    insert into public.sales (id, org_id, register_id, location_id, receipt_seq, mode, completed_at,
                              priced_as_of, cashier_user_id, items_total_cents, vat_cents, non_vat_cents,
                              cash_rounding_cents, amount_due_cents, client_due_cents)
    values (v_id, v_org, v_reg, v_loc, (s ->> 'receipt_seq')::int, s ->> 'mode',
            (s ->> 'completed_at')::timestamptz, (s ->> 'priced_as_of')::timestamptz, v_user,
            (s ->> 'items_total')::int, (s ->> 'vat')::int, (s ->> 'non_vat')::int,
            (s ->> 'cash_rounding')::int, (s ->> 'amount_due')::int, (s ->> 'client_due')::int)
    on conflict (id) do nothing;
    get diagnostics v_inserted = row_count;
  exception when unique_violation then
    return 'receipt_clash';
  end;

  if v_inserted = 0 then
    select * into v_existing from public.sales where id = v_id;
    -- A sale id that belongs to another shop is never reported as ours.
    if v_existing.org_id = v_org and v_existing.register_id = v_reg then
      return 'duplicate';
    end if;
    raise exception 'sale id in use' using errcode = '23505';
  end if;

  -- A till's approval: single use, this register, purpose discount, spent within 30 minutes of the
  -- PIN check (by the sale's own time, so a sale made online-then-queued still counts).
  if v_approval is not null then
    v_approver := null;
    select a.approver_user_id into v_approver
      from public.register_approvals a
     where a.id = v_approval and a.org_id = v_org and a.register_id = v_reg
       and a.purpose = 'discount' and a.consumed_at is null
       and v_completed between a.created_at - interval '1 minute' and a.created_at + interval '30 minutes'
     for update;
    if v_approver is null then
      raise exception 'approval not valid' using errcode = '42501';
    end if;
    update public.register_approvals set consumed_at = now(), consumed_for = v_id where id = v_approval;
  end if;
  if v_approver is not null and not app.is_manager(v_approver, v_org) then
    raise exception 'approver is not a manager' using errcode = '42501';
  end if;

  insert into public.sale_lines (id, org_id, sale_id, line_no, kind, variant_id, product_id, name, qty,
                                 unit_price_cents, modifiers, serial, discount_cents, tax_category,
                                 tax_rate_bp, net_cents, vat_cents, gross_cents)
  select gen_random_uuid(), v_org, v_id, l.ord::int, l.value ->> 'kind',
         (l.value ->> 'variant_id')::uuid, (l.value ->> 'product_id')::uuid, l.value ->> 'name',
         (l.value ->> 'qty')::int, (l.value ->> 'unit_price_cents')::int,
         coalesce(l.value -> 'modifiers', '[]'::jsonb), nullif(l.value ->> 'serial', ''),
         coalesce((l.value ->> 'discount_cents')::int, 0), l.value ->> 'tax_category',
         (l.value ->> 'tax_rate_bp')::int, (l.value ->> 'net_cents')::int,
         (l.value ->> 'vat_cents')::int, (l.value ->> 'gross_cents')::int
  from jsonb_array_elements(p -> 'lines') with ordinality as l(value, ord);

  insert into public.payments (id, org_id, sale_id, method, amount_cents, tendered_cents, change_cents)
  values (gen_random_uuid(), v_org, v_id, coalesce(p -> 'payment' ->> 'method', 'cash'),
          (p -> 'payment' ->> 'amount')::int, (p -> 'payment' ->> 'tendered')::int,
          (p -> 'payment' ->> 'change')::int);

  -- One ledger row per tracked variant. Negative stock is allowed (reported, not blocked).
  insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, ref_id, actor_user_id)
  select gen_random_uuid(), v_org, l.variant_id, v_loc, -sum(l.qty)::int, 'sale', v_id, v_user
  from public.sale_lines l
  join public.products p on p.org_id = l.org_id and p.id = l.product_id
  where l.sale_id = v_id and l.kind = 'item' and l.variant_id is not null and p.track_stock
  group by l.variant_id;

  if v_approver is not null then
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
    values (gen_random_uuid(), v_org, v_user, 'sale.discount_override', 'sale', v_id,
            jsonb_build_object('approved_by', v_approver, 'register_id', v_reg,
                               'approval', case when v_approval is not null then 'pin_verified'
                                                else 'manager_session' end,
                               'discount_cents', (select coalesce(sum(l.discount_cents), 0)
                                                  from public.sale_lines l where l.sale_id = v_id)));
  end if;

  update public.registers set last_seen_at = now() where id = v_reg and org_id = v_org;
  return 'created';
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function ops.pair_register(text, text) from public, anon, authenticated;
revoke all on function ops.device_auth(text) from public, anon, authenticated;
revoke all on function ops.device_feed_meta(text) from public, anon, authenticated;
revoke all on function ops.device_sync_meta(text) from public, anon, authenticated;
revoke all on function ops.record_sync_rejection(jsonb) from public, anon, authenticated;
revoke all on function ops.device_feed_table(text, text, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function ops.device_sale_catalog_as_of(text, uuid[], uuid[], timestamptz) from public, anon, authenticated;
revoke all on function ops.device_sales_known(text, uuid[]) from public, anon, authenticated;
revoke all on function ops.pin_attempt_begin(text, uuid) from public, anon, authenticated;
revoke all on function ops.pin_attempt_finish(text, uuid, boolean) from public, anon, authenticated;
revoke all on function ops.issue_approval(text, uuid, text) from public, anon, authenticated;
revoke all on function ops.record_register_events(text, jsonb) from public, anon, authenticated;
revoke all on function ops.record_sale(jsonb) from public, anon, authenticated;
grant execute on function ops.pair_register(text, text) to service_role, tillflow_ops;
grant execute on function ops.device_auth(text) to service_role, tillflow_ops;
grant execute on function ops.device_feed_meta(text) to service_role, tillflow_ops;
grant execute on function ops.device_sync_meta(text) to service_role, tillflow_ops;
grant execute on function ops.record_sync_rejection(jsonb) to service_role, tillflow_ops;
grant execute on function ops.device_feed_table(text, text, timestamptz, uuid, integer) to service_role, tillflow_ops;
grant execute on function ops.device_sale_catalog_as_of(text, uuid[], uuid[], timestamptz) to service_role, tillflow_ops;
grant execute on function ops.device_sales_known(text, uuid[]) to service_role, tillflow_ops;
grant execute on function ops.pin_attempt_begin(text, uuid) to service_role, tillflow_ops;
grant execute on function ops.pin_attempt_finish(text, uuid, boolean) to service_role, tillflow_ops;
grant execute on function ops.issue_approval(text, uuid, text) to service_role, tillflow_ops;
grant execute on function ops.record_register_events(text, jsonb) to service_role, tillflow_ops;
grant execute on function ops.record_sale(jsonb) to service_role, tillflow_ops;
