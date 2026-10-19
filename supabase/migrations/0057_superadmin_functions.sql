-- Superadmin console (/superadmin): functions only, no new table.
--
-- Every function checks app.is_platform_admin() FIRST (a row in platform_admins AND a two-step
-- aal2 session) and raises 42501 otherwise, so a normal owner, manager, cashier, anon or an admin
-- on a one-step session can call none of them. They are SECURITY DEFINER because the admin reads
-- across shops; they return counts and labels only (never pin hashes, emails or customer data).
-- Writes and per-business reads add an audit_log row (action superadmin.*, ids and short staff
-- text only). Lists that span many businesses are not audit-logged (audit rows belong to one
-- business), as with admin_match_references.

-- ---------------------------------------------------------------- hide superadmin rows from tenants
-- audit_log is readable by a business's owners and managers. Rows written by the platform admin
-- (who looked, the admin's user id, the internal reason note) are for us, not for the customer, so
-- a restrictive policy hides them. billing.unpaused is hidden too: admin_unpause keeps the admin's
-- free-text reason in it. (billing.marked_paid carries no note and stays visible.) The SECURITY
-- DEFINER writers and readers still see all of them.
create policy audit_log_hide_superadmin on public.audit_log as restrictive for select
  using (action not like 'superadmin.%' and action <> 'billing.unpaused');

-- ---------------------------------------------------------------- audit helper
create function app.superadmin_audit(p_org uuid, p_action text, p_entity text, p_entity_id uuid, p_before jsonb, p_after jsonb)
returns void
language sql volatile security definer set search_path = ''
as $$
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, before, after)
  values (gen_random_uuid(), p_org, (select app.current_user_id()), p_action, p_entity, p_entity_id, p_before, p_after)
$$;
revoke all on function app.superadmin_audit(uuid, text, text, uuid, jsonb, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------- admin_list_orgs
create function public.admin_list_orgs(p_search text, p_limit int, p_offset int) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_search text := nullif(btrim(coalesce(p_search, '')), '');
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 then
    raise exception 'bad paging' using errcode = '22023';
  end if;
  if v_search is not null and char_length(v_search) > 100 then
    raise exception 'search too long' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc, x.id)
      from (
        select o.id, o.name, o.status as org_status, o.created_at, o.trial_ends_at,
               s.status as billing_status,
               (select max(i.paid_at) from public.billing_invoices i
                 where i.org_id = o.id and i.status = 'paid') as last_payment_at,
               greatest(
                 (select max(sa.received_at) from public.sales sa where sa.org_id = o.id),
                 (select max(r.last_seen_at) from public.registers r where r.org_id = o.id)) as last_sync_at,
               (select count(*) from public.registers r where r.org_id = o.id)::int as tills
          from public.organisations o
          left join public.subscriptions s on s.org_id = o.id
         where v_search is null or o.name ilike '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%'
         order by o.created_at desc, o.id
         limit p_limit offset p_offset) x), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- admin_org_name
-- Just the business name, for the read-only view banner (the name is already in the org list, so
-- this is not audited; every page that then reads business data audits itself).
create function public.admin_org_name(p_org uuid) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare
  v text;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select o.name into v from public.organisations o where o.id = p_org;
  if v is null then
    raise exception 'no such business' using errcode = '22023';
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------- admin_org_usage
create function public.admin_org_usage(p_org uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'no such business' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'org_id', o.id,
    'name', o.name,
    'org_status', o.status,
    'billing_status', s.status,
    'trial_ends_at', o.trial_ends_at,
    'business_type', o.business_type,
    'created_at', o.created_at,
    'sales_7d', (select count(*) from public.sales sa where sa.org_id = o.id and sa.received_at >= now() - interval '7 days'),
    'sales_30d', (select count(*) from public.sales sa where sa.org_id = o.id and sa.received_at >= now() - interval '30 days'),
    'products', (select count(*) from public.products p where p.org_id = o.id and p.archived_at is null),
    'staff', (select count(*) from public.memberships m where m.org_id = o.id),
    'tills', (select count(*) from public.registers r where r.org_id = o.id),
    'tills_last_seen', (select max(r.last_seen_at) from public.registers r where r.org_id = o.id),
    'last_sale_at', (select max(sa.received_at) from public.sales sa where sa.org_id = o.id),
    'open_attention', (select count(*) from public.sync_rejections q where q.org_id = o.id and q.status = 'open'),
    'open_invoices', (select count(*) from public.billing_invoices i where i.org_id = o.id and i.status = 'issued'),
    'last_payment_at', (select max(i.paid_at) from public.billing_invoices i where i.org_id = o.id and i.status = 'paid'))
    into v
    from public.organisations o
    left join public.subscriptions s on s.org_id = o.id
   where o.id = p_org;
  perform app.superadmin_audit(p_org, 'superadmin.viewed', 'organisation', p_org, null, jsonb_build_object('page', 'usage'));
  return v;
end
$$;

-- ---------------------------------------------------------------- admin_extend_trial
create function public.admin_extend_trial(p_org uuid, p_days int, p_note text) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
  v_old timestamptz;
  v_new timestamptz;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_days is null or p_days < 1 or p_days > 90 then
    raise exception 'days must be 1 to 90' using errcode = '22023';
  end if;
  if char_length(v_note) < 5 or char_length(v_note) > 300 then
    raise exception 'a note of 5 to 300 characters is required' using errcode = '22023';
  end if;
  -- Subscription lock first, as pause, unpause and ops.billing_pause do. (Mark paid locks the invoice
  -- first and then the subscription; no path locks an invoice after a subscription, so no cycle.)
  perform 1 from public.subscriptions s where s.org_id = p_org for update;
  if not found then
    raise exception 'no such business' using errcode = '22023';
  end if;
  select o.trial_ends_at into v_old from public.organisations o
   where o.id = p_org and o.status = 'trial'
     and exists (select 1 from public.subscriptions s where s.org_id = p_org and s.status = 'trial');
  if not found then
    raise exception 'business is not on a trial' using errcode = '22023';
  end if;
  -- Extend from the later of the current end and now, so an expired-but-unbilled trial gets the full
  -- days. A trial with no end yet (the billing job has not stamped it) counts from now.
  v_new := greatest(coalesce(v_old, now()), now()) + make_interval(days => p_days);
  update public.organisations set trial_ends_at = v_new, updated_at = now() where id = p_org;
  perform app.superadmin_audit(p_org, 'superadmin.trial_extended', 'organisation', p_org,
    jsonb_build_object('trial_ends_at', v_old),
    jsonb_build_object('trial_ends_at', v_new, 'days', p_days, 'note', v_note));
end
$$;

-- ---------------------------------------------------------------- admin_pause
create function public.admin_pause(p_org uuid, p_note text) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_note text := btrim(coalesce(p_note, ''));
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_note) < 5 or char_length(v_note) > 300 then
    raise exception 'a note of 5 to 300 characters is required' using errcode = '22023';
  end if;
  perform 1 from public.subscriptions s where s.org_id = p_org for update;
  if not found then
    raise exception 'no such business' using errcode = '22023';
  end if;
  update public.organisations set status = 'read_only', updated_at = now()
   where id = p_org and status in ('trial', 'active');
  if not found then
    raise exception 'business cannot be paused' using errcode = '22023';
  end if;
  update public.subscriptions set status = 'paused', paused_at = now(), hold_until = null, updated_at = now()
   where org_id = p_org;
  perform app.superadmin_audit(p_org, 'superadmin.paused', 'organisation', p_org, null,
    jsonb_build_object('note', v_note));
end
$$;

-- ---------------------------------------------------------------- read-only "view as" functions
-- Each returns a small jsonb document and writes one superadmin.viewed audit row. Nothing here takes
-- a "view as" identity: the caller is always the admin, and no write function exists for these views.
create function public.admin_view_dashboard(p_org uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Europe/Dublin')::date;
  v jsonb;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'name', o.name,
    'business_type', o.business_type,
    'org_status', o.status,
    'sales_today', (select count(*) from public.sales sa where sa.org_id = o.id
                     and (sa.completed_at at time zone 'Europe/Dublin')::date = v_today),
    'takings_today_cents', (select coalesce(sum(sa.amount_due_cents), 0) from public.sales sa where sa.org_id = o.id
                     and (sa.completed_at at time zone 'Europe/Dublin')::date = v_today),
    'sales_7d', (select count(*) from public.sales sa where sa.org_id = o.id and sa.completed_at >= now() - interval '7 days'),
    'takings_7d_cents', (select coalesce(sum(sa.amount_due_cents), 0) from public.sales sa where sa.org_id = o.id
                     and sa.completed_at >= now() - interval '7 days'),
    'open_attention', (select count(*) from public.sync_rejections q where q.org_id = o.id and q.status = 'open'),
    'to_review', (select count(*) from public.sales sa where sa.org_id = o.id and cardinality(sa.review_flags) > 0
                     and sa.completed_at >= now() - interval '30 days'))
    into v
    from public.organisations o where o.id = p_org;
  if v is null then
    raise exception 'no such business' using errcode = '22023';
  end if;
  perform app.superadmin_audit(p_org, 'superadmin.viewed', 'organisation', p_org, null, jsonb_build_object('page', 'dashboard'));
  return v;
end
$$;

create function public.admin_view_sales(p_org uuid, p_limit int, p_before timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'bad limit' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'no such business' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.completed_at desc, x.id), '[]'::jsonb) into v
    from (
      select sa.id, sa.receipt_seq, r.name as till, sa.completed_at, sa.amount_due_cents, sa.vat_cents,
             sa.review_flags
        from public.sales sa
        join public.registers r on r.org_id = sa.org_id and r.id = sa.register_id
       where sa.org_id = p_org and (p_before is null or sa.completed_at < p_before)
       order by sa.completed_at desc, sa.id
       limit p_limit) x;
  perform app.superadmin_audit(p_org, 'superadmin.viewed', 'organisation', p_org, null, jsonb_build_object('page', 'sales'));
  return v;
end
$$;

create function public.admin_view_products(p_org uuid, p_limit int, p_offset int) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 or p_offset is null or p_offset < 0 then
    raise exception 'bad paging' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'no such business' using errcode = '22023';
  end if;
  -- Names, tax category and prices only: no cost prices (variant_costs is not read).
  select coalesce(jsonb_agg(to_jsonb(x) order by x.name, x.id), '[]'::jsonb) into v
    from (
      select p.id, p.name, p.tax_category, p.track_stock,
             (select min(va.price_incl_vat_cents) from public.variants va
               where va.org_id = p.org_id and va.product_id = p.id and va.archived_at is null) as price_from_cents,
             (select count(*) from public.variants va
               where va.org_id = p.org_id and va.product_id = p.id and va.archived_at is null)::int as variants
        from public.products p
       where p.org_id = p_org and p.archived_at is null
       order by p.name, p.id
       limit p_limit offset p_offset) x;
  perform app.superadmin_audit(p_org, 'superadmin.viewed', 'organisation', p_org, null, jsonb_build_object('page', 'products'));
  return v;
end
$$;

create function public.admin_view_staff(p_org uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'no such business' using errcode = '22023';
  end if;
  -- Display name, role and kind only: never pin hashes, lockout counters, emails or user ids.
  select coalesce(jsonb_agg(to_jsonb(x) order by x.role, x.display_name), '[]'::jsonb) into v
    from (
      select m.display_name, m.role, m.till_only
        from public.memberships m
       where m.org_id = p_org
       limit 200) x;
  perform app.superadmin_audit(p_org, 'superadmin.viewed', 'organisation', p_org, null, jsonb_build_object('page', 'staff'));
  return v;
end
$$;

create function public.admin_view_shifts(p_org uuid, p_limit int) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v jsonb;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'bad limit' using errcode = '22023';
  end if;
  if not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'no such business' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.opened_at desc, x.id), '[]'::jsonb) into v
    from (
      select sh.id, r.name as till, sh.opened_at, sh.float_cents,
             c.z_seq, c.closed_at, c.counted_cents, c.expected_cents, c.over_short_cents
        from public.shifts sh
        join public.registers r on r.org_id = sh.org_id and r.id = sh.register_id
        left join public.shift_closes c on c.org_id = sh.org_id and c.shift_id = sh.id
       where sh.org_id = p_org
       order by sh.opened_at desc, sh.id
       limit p_limit) x;
  perform app.superadmin_audit(p_org, 'superadmin.viewed', 'organisation', p_org, null, jsonb_build_object('page', 'shifts'));
  return v;
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function
  public.admin_list_orgs(text, int, int), public.admin_org_name(uuid), public.admin_org_usage(uuid),
  public.admin_extend_trial(uuid, int, text), public.admin_pause(uuid, text),
  public.admin_view_dashboard(uuid), public.admin_view_sales(uuid, int, timestamptz),
  public.admin_view_products(uuid, int, int), public.admin_view_staff(uuid),
  public.admin_view_shifts(uuid, int)
  from public, anon;
grant execute on function
  public.admin_list_orgs(text, int, int), public.admin_org_name(uuid), public.admin_org_usage(uuid),
  public.admin_extend_trial(uuid, int, text), public.admin_pause(uuid, text),
  public.admin_view_dashboard(uuid), public.admin_view_sales(uuid, int, timestamptz),
  public.admin_view_products(uuid, int, int), public.admin_view_staff(uuid),
  public.admin_view_shifts(uuid, int)
  to authenticated;
