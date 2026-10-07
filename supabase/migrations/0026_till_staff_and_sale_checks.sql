-- Hand-written: Phase 1 hardening.
--   1. Till-only staff: a manager adds a cashier by name with a PIN. The cashier has no login
--      account: memberships.user_id has no FK to auth.users, so the database makes a fresh id,
--      and the row is marked till_only so it can never authorise a session.
--   2. ops.record_sale re-checks the device token (when given) and every sum in SQL, and stores
--      the till's VAT and the review flags (sales are saved and flagged, never edited later).
--   3. public.mark_sale_reviewed: a manager clears a flagged sale from the review list (audit row;
--      the sale itself stays untouched).

-- ---------------------------------------------------------------- till_only
grant select (till_only) on public.memberships to authenticated;

-- Same as 0024, plus: a till-only row never gives a signed-in session access, even if its id
-- ever matched a real user. Till staff only work through a paired till (ops.* by device token).
create or replace function app.org_ids_with_roles(roles public.membership_role[]) returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.org_id from public.memberships m
  where m.user_id = (select app.current_user_id())
    and m.role = any (roles)
    and not m.till_only
    and not (m.role = 'cashier' and (select app.session_via_oauth()))
    and (
      (select app.current_aal()) = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
        where f.user_id = m.user_id and f.status = 'verified'
      )
    )
$$;

-- ---------------------------------------------------------------- app.valid_pin_hash
-- Only Argon2id at the agreed cost or stronger (m >= 19 MiB, t >= 2): nobody can store a cheap
-- hash that every till would then hold. One check for every function that writes a PIN hash.
create function app.valid_pin_hash(p_hash text) returns boolean
language plpgsql immutable set search_path = ''
as $$
declare
  v text[];
begin
  if p_hash is null or char_length(p_hash) > 300 then
    return false;
  end if;
  v := regexp_match(p_hash, '^\$argon2id\$v=19\$m=(\d{1,8}),t=(\d{1,4}),p=(\d{1,2})\$');
  return v is not null and v[1]::bigint >= 19456 and v[2]::int >= 2 and v[3]::int >= 1;
end
$$;
revoke all on function app.valid_pin_hash(text) from public, anon;
grant execute on function app.valid_pin_hash(text) to authenticated, service_role, tillflow_ops;

-- Same behaviour as 0023, now through the shared check.
create or replace function public.set_my_pin_hash(p_org uuid, p_hash text, p_display_name text, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_name text := btrim(p_display_name);
begin
  if v_user is null or p_org is null or p_audit_id is null
     or not exists (select 1 from app.current_org_ids() o where o = p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.valid_pin_hash(p_hash) or v_name is null or char_length(v_name) not between 1 and 40 then
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

-- ---------------------------------------------------------------- public.add_till_staff
-- A manager (or owner) adds a cashier who only uses the till. The PIN hash is made on the server.
-- The cashier's user id is made HERE, never taken from the caller: a caller-chosen id could be a
-- real account (in this or another shop), which would then gain a membership it never asked for.
create function public.add_till_staff(p_org uuid, p_membership_id uuid,
                                      p_display_name text, p_pin_hash text, p_audit_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := (select app.current_user_id());
  v_name text := btrim(p_display_name);
  v_user uuid := gen_random_uuid();
begin
  if v_actor is null or p_org is null or p_membership_id is null
     or p_audit_id is null
     or not exists (select 1 from app.manager_org_ids() o where o = p_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.valid_pin_hash(p_pin_hash) or v_name is null or char_length(v_name) not between 1 and 40 then
    raise exception 'bad input' using errcode = '22023';
  end if;
  -- Two people with one name could not be told apart on the till's staff picker.
  if exists (select 1 from public.memberships m
              where m.org_id = p_org and lower(m.display_name) = lower(v_name)) then
    raise exception 'name in use' using errcode = '23505';
  end if;

  insert into public.memberships (id, org_id, user_id, role, display_name, pin_hash, pin_set_at, till_only)
  values (p_membership_id, p_org, v_user, 'cashier', v_name, p_pin_hash, now(), true);

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (p_audit_id, p_org, v_actor, 'staff.added', 'membership', v_user,
          jsonb_build_object('role', 'cashier', 'display_name', v_name));
  return v_user;
end
$$;
revoke all on function public.add_till_staff(uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.add_till_staff(uuid, uuid, text, text, uuid) to authenticated;

-- ---------------------------------------------------------------- public.set_member_pin
-- A manager sets a till-only cashier's PIN (the cashier types it on the manager's screen). People
-- with a login set their own (My till PIN); a manager can only clear theirs (reset_member_pin), so
-- nobody ever knows another account holder's PIN.
create function public.set_member_pin(p_membership uuid, p_hash text, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := (select app.current_user_id());
  v_org uuid;
  v_target uuid;
begin
  -- Check the caller before locking anything, so a stranger cannot hold another shop's row lock.
  select org_id, user_id into v_org, v_target
    from public.memberships where id = p_membership and till_only and role = 'cashier';
  if v_actor is null or v_org is null or p_audit_id is null
     or not exists (select 1 from app.manager_org_ids() o where o = v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not app.valid_pin_hash(p_hash) then
    raise exception 'bad input' using errcode = '22023';
  end if;

  update public.memberships
     set pin_hash = p_hash, pin_set_at = now(), pin_failed_count = 0, pin_locked_until = null
   where id = p_membership and org_id = v_org and till_only and role = 'cashier';

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (p_audit_id, v_org, v_actor, 'staff.pin_set', 'membership', v_target);
end
$$;
revoke all on function public.set_member_pin(uuid, text, uuid) from public, anon;
grant execute on function public.set_member_pin(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------- public.remove_till_staff
-- A manager removes a till-only cashier. Past sales keep cashier_user_id (no FK), so history stays.
-- Members with a login are removed by an owner, as before.
create function public.remove_till_staff(p_membership uuid, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := (select app.current_user_id());
  m public.memberships%rowtype;
begin
  select * into m from public.memberships where id = p_membership and till_only and role = 'cashier';
  if v_actor is null or m.id is null or p_audit_id is null
     or not exists (select 1 from app.manager_org_ids() o where o = m.org_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  delete from public.memberships where id = p_membership and org_id = m.org_id and till_only and role = 'cashier';

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, before)
  values (p_audit_id, m.org_id, v_actor, 'staff.removed', 'membership', m.user_id,
          jsonb_build_object('role', m.role, 'display_name', m.display_name));
end
$$;
revoke all on function public.remove_till_staff(uuid, uuid) from public, anon;
grant execute on function public.remove_till_staff(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- public.mark_sale_reviewed
-- A manager looked at a flagged sale. Sales are never edited: the review is an audit row, and the
-- review list hides flagged sales that have one.
create function public.mark_sale_reviewed(p_sale uuid, p_note text, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_actor uuid := (select app.current_user_id());
  v_org uuid;
  v_note text := nullif(btrim(p_note), '');
begin
  select org_id into v_org from public.sales where id = p_sale and review_flags <> '{}';
  if v_actor is null or v_org is null or p_audit_id is null
     or not exists (select 1 from app.manager_org_ids() o where o = v_org) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if v_note is not null and char_length(v_note) > 500 then
    raise exception 'bad input' using errcode = '22023';
  end if;
  if exists (select 1 from public.audit_log a
              where a.org_id = v_org and a.action = 'sale.reviewed' and a.entity_id = p_sale) then
    return; -- already reviewed: nothing to do
  end if;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (p_audit_id, v_org, v_actor, 'sale.reviewed', 'sale', p_sale,
          jsonb_build_object('note', v_note));
end
$$;
revoke all on function public.mark_sale_reviewed(uuid, text, uuid) from public, anon;
grant execute on function public.mark_sale_reviewed(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------- ops.record_sale
-- p: as in 0023, plus sale.client_vat and sale.review_flags.
-- p_token_hash: the till's device token hash. The sync route always passes it, and the sale's org
-- and register must be the token's. Only the trusted back-office path (a manager's Try again) passes
-- null. Every sum is re-checked here, so a bug in the TS money glue cannot store a sale that does
-- not add up.
drop function ops.record_sale(jsonb);
create function ops.record_sale(p jsonb, p_token_hash text default null) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jsonb := p -> 'sale';
  pay jsonb := p -> 'payment';
  v_org uuid := (s ->> 'org_id')::uuid;
  v_id uuid := (s ->> 'id')::uuid;
  v_reg uuid := (s ->> 'register_id')::uuid;
  v_user uuid := (s ->> 'user_id')::uuid;
  v_approver uuid := nullif(s ->> 'approved_by', '')::uuid;
  v_approval uuid := nullif(s ->> 'approval_id', '')::uuid;
  v_completed timestamptz := (s ->> 'completed_at')::timestamptz;
  v_items_total int := (s ->> 'items_total')::int;
  v_vat int := (s ->> 'vat')::int;
  v_non_vat int := (s ->> 'non_vat')::int;
  v_rounding int := (s ->> 'cash_rounding')::int;
  v_due int := (s ->> 'amount_due')::int;
  v_amount int := (pay ->> 'amount')::int;
  v_tendered int := (pay ->> 'tendered')::int;
  v_change int := (pay ->> 'change')::int;
  v_flags text[] := coalesce(array(select jsonb_array_elements_text(coalesce(s -> 'review_flags', '[]'::jsonb))), '{}');
  v_loc uuid;
  v_inserted int;
  v_existing public.sales%rowtype;
  v_sum_gross bigint;
  v_sum_vat bigint;
  v_sum_deposit bigint;
  v_bad_lines int;
begin
  -- A till never names an approver: with a token, the approver comes only from a spent,
  -- PIN-verified register_approvals row below. approved_by is for the trusted back office alone.
  if p_token_hash is not null then
    v_approver := null;
  end if;
  if p_token_hash is not null and not exists (
       select 1 from app.device_register(p_token_hash) d
        where d.org_id = v_org and d.register_id = v_reg) then
    raise exception 'not this till' using errcode = '42501';
  end if;
  if not app.is_member(v_user, v_org) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select r.location_id into v_loc from public.registers r where r.id = v_reg and r.org_id = v_org;
  if v_loc is null then
    raise exception 'unknown register' using errcode = '42501';
  end if;

  -- The sums, from the lines up. Any difference means the record is wrong: refuse it (the sync
  -- route turns this into a rejection a manager sees, so it never blocks the till's queue).
  -- Each item line: VAT split exactly as src/lib/money splitVat does it (net = gross * 10000 /
  -- (10000 + rate), half away from zero, which is Postgres round(numeric)), and the discount is
  -- what the full price lost. Each deposit line: unit x qty. No other kind of line yet.
  select coalesce(sum((l ->> 'gross_cents')::bigint) filter (where l ->> 'kind' = 'item'), 0),
         coalesce(sum((l ->> 'vat_cents')::bigint) filter (where l ->> 'kind' = 'item'), 0),
         coalesce(sum((l ->> 'gross_cents')::bigint) filter (where l ->> 'kind' = 'deposit'), 0),
         count(*) filter (where
           case l ->> 'kind'
             when 'item' then
               num_nulls(l ->> 'gross_cents', l ->> 'net_cents', l ->> 'vat_cents', l ->> 'tax_rate_bp',
                         l ->> 'unit_price_cents', l ->> 'qty') > 0
               or (l ->> 'tax_rate_bp')::int not between 0 and 10000
               or (l ->> 'net_cents')::bigint
                  <> round((l ->> 'gross_cents')::numeric * 10000 / (10000 + (l ->> 'tax_rate_bp')::int))
               or (l ->> 'net_cents')::bigint + (l ->> 'vat_cents')::bigint <> (l ->> 'gross_cents')::bigint
               or coalesce((l ->> 'discount_cents')::bigint, 0) < 0
               or coalesce((l ->> 'discount_cents')::bigint, 0)
                  <> (l ->> 'unit_price_cents')::bigint * (l ->> 'qty')::bigint - (l ->> 'gross_cents')::bigint
             when 'deposit' then
               num_nulls(l ->> 'gross_cents', l ->> 'unit_price_cents', l ->> 'qty') > 0
               or (l ->> 'gross_cents')::bigint
                  <> (l ->> 'unit_price_cents')::bigint * (l ->> 'qty')::bigint
             else true
           end)
    into v_sum_gross, v_sum_vat, v_sum_deposit, v_bad_lines
    from jsonb_array_elements(p -> 'lines') l;
  if num_nulls(v_items_total, v_vat, v_non_vat, v_rounding, v_due, v_amount, v_tendered, v_change) > 0
     or v_bad_lines > 0
     or v_sum_gross <> v_items_total or v_sum_vat <> v_vat or v_sum_deposit <> v_non_vat
     or v_due <> v_items_total + v_non_vat + v_rounding
     -- 5c cash rounding: a cash total ends in 0 or 5 and moves by at most 2c; nothing else rounds.
     or (coalesce(pay ->> 'method', 'cash') = 'cash'
         and (v_rounding not between -2 and 2 or mod(v_due, 5) <> 0))
     or (coalesce(pay ->> 'method', 'cash') <> 'cash' and v_rounding <> 0)
     or v_amount <> v_due or v_tendered < v_amount or v_change <> v_tendered - v_amount then
    raise exception 'sale does not add up' using errcode = '22023';
  end if;
  -- The till's VAT is compared, never trusted; the flag must agree with it.
  if 'vat_differs' = any (v_flags) and (s ->> 'client_vat') is null then
    raise exception 'bad input' using errcode = '22023';
  end if;

  begin
    insert into public.sales (id, org_id, register_id, location_id, receipt_seq, mode, completed_at,
                              priced_as_of, cashier_user_id, items_total_cents, vat_cents, non_vat_cents,
                              cash_rounding_cents, amount_due_cents, client_due_cents,
                              client_vat_cents, review_flags)
    values (v_id, v_org, v_reg, v_loc, (s ->> 'receipt_seq')::int, s ->> 'mode', v_completed,
            (s ->> 'priced_as_of')::timestamptz, v_user, v_items_total, v_vat, v_non_vat,
            v_rounding, v_due, (s ->> 'client_due')::int,
            nullif(s ->> 'client_vat', '')::int, v_flags)
    on conflict (id) do nothing;
    get diagnostics v_inserted = row_count;
  exception when unique_violation then
    return 'receipt_clash';
  end;

  if v_inserted = 0 then
    select * into v_existing from public.sales where id = v_id;
    if v_existing.org_id = v_org and v_existing.register_id = v_reg then
      return 'duplicate';
    end if;
    raise exception 'sale id in use' using errcode = '23505';
  end if;

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
  values (gen_random_uuid(), v_org, v_id, coalesce(pay ->> 'method', 'cash'),
          v_amount, v_tendered, v_change);

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
revoke all on function ops.record_sale(jsonb, text) from public, anon, authenticated;
grant execute on function ops.record_sale(jsonb, text) to service_role, tillflow_ops;
