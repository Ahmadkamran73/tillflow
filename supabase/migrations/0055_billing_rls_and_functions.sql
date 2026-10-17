-- Hand-written: subscription billing by bank transfer (PLAN.md section 14). 0054 made the tables.
--
-- Who can do what:
--   * An OWNER can read their own business's subscription and invoices (SELECT only).
--   * Nothing is written by a client. Invoices are issued, chased and the account paused by the
--     billing jobs through ops.billing_* (SECURITY DEFINER, service_role / tillflow_ops only).
--   * A SUPER-ADMIN (a row in platform_admins AND a two-step (aal2) session) lists invoices, marks
--     them paid, unpauses a business and matches bank-statement references through public.admin_*.
--     Each of those checks app.is_platform_admin() first and writes an audit_log row (ids and
--     amounts only; never bank statement text).
--   * Invoices are append-only in everything that matters: a trigger refuses to change numbers,
--     amounts, dates or the reference, refuses DELETE and TRUNCATE, and only lets an issued
--     invoice move to paid or void once.
--
-- Invoice numbers have no gaps: ops.billing_issue_invoice locks the one counter row, and the number
-- and the invoice are written in the same transaction, so a failure leaves no hole. Money maths
-- (price + VAT) is done by src/lib/money in TypeScript; the database checks that the figures it
-- is given add up and that the VAT is within half a cent of the rate.
--
-- Read-only mode: app.org_writable(org) is false once the business is paused (organisations.status
-- read_only) or closed. Writes through ops.record_sale / record_refund / record_shift_event, the
-- customer and import functions and the catalogue / stock tables (restrictive policies) refuse with
-- TF004. Reads, report downloads and the whole-account export are untouched.

-- ---------------------------------------------------------------- reference check (twin of reference.ts)
create function app.billing_reference_check(p_payload text) returns text
language plpgsql immutable strict set search_path = ''
as $$
declare
  c_symbols constant text := '0123456789ABCDEFGHJKMNPQRSTUVWXYZ';
  c_weights constant int[] := array[1, 2, 4, 5, 7, 8, 10, 14];
  v_sum int := 0;
  v int;
begin
  if char_length(p_payload) <> 8 then
    raise exception 'payload must be 8 characters' using errcode = '22023';
  end if;
  for i in 1..8 loop
    v := position(substr(p_payload, i, 1) in c_symbols) - 1;
    if v < 0 then
      raise exception 'bad character in payload' using errcode = '22023';
    end if;
    v_sum := v_sum + v * c_weights[i];
  end loop;
  return substr(c_symbols, (v_sum % 33) + 1, 1);
end
$$;

create function app.billing_reference_valid(p_ref text) returns boolean
language plpgsql immutable set search_path = ''
as $$
begin
  if p_ref is null or p_ref !~ '^TF-[0-9A-HJKMNP-Z]{4}-[0-9]{4}-[0-9A-HJKMNP-Z]$' then
    return false;
  end if;
  return app.billing_reference_check(substr(p_ref, 4, 4) || substr(p_ref, 9, 4)) = substr(p_ref, 14, 1);
end
$$;
revoke all on function app.billing_reference_check(text), app.billing_reference_valid(text) from public;
grant execute on function app.billing_reference_check(text), app.billing_reference_valid(text)
  to authenticated, service_role, tillflow_ops;

-- ---------------------------------------------------------------- platform admin and writable helpers
-- The only reader of platform_admins. A super-admin must also be on a two-step (aal2) session.
create function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select (select app.current_aal()) = 'aal2'
     and exists (select 1 from public.platform_admins a where a.user_id = (select app.current_user_id()))
$$;
revoke all on function app.is_platform_admin() from public;
grant execute on function app.is_platform_admin() to authenticated, service_role;

-- For the app's page guard: "am I a super-admin on a two-step session?" (the admin_* functions check
-- again on every call; this only lets the page answer 404 to everyone else).
create function public.am_i_platform_admin() returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select app.is_platform_admin()), false)
$$;
revoke all on function public.am_i_platform_admin() from public, anon;
grant execute on function public.am_i_platform_admin() to authenticated;

-- What a client is told when a write is refused because the business is paused: the paused answer
-- (TF004) only to someone who belongs to that business, an ordinary "not allowed" to anyone else, so
-- a stranger cannot find out whether another business is paused by guessing its id.
create function app.refuse_paused(p_org uuid) returns void
language plpgsql stable security definer set search_path = ''
as $$
begin
  if p_org is null or p_org not in (select app.current_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  raise exception 'this business is paused' using errcode = 'TF004';
end
$$;
revoke all on function app.refuse_paused(uuid) from public;
grant execute on function app.refuse_paused(uuid) to authenticated;

-- True while the business may write: trial and active. Paused (read_only) and closed may not.
create function app.org_writable(p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select coalesce((select o.status in ('trial', 'active') from public.organisations o where o.id = p_org), false)
$$;
revoke all on function app.org_writable(uuid) from public;
grant execute on function app.org_writable(uuid) to authenticated, service_role, tillflow_ops;

-- A write that happened BEFORE the pause (a till that was offline) is still accepted when it syncs.
create function app.org_accepts_at(p_org uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.org_writable(p_org)
      or exists (select 1 from public.subscriptions s
                  where s.org_id = p_org and s.paused_at is not null and p_at is not null
                    and p_at < s.paused_at
                    -- only for a few days after the pause: a till that was offline, not a back-dated sale
                    and now() < s.paused_at + interval '3 days')
$$;
revoke all on function app.org_accepts_at(uuid, timestamptz) from public;
grant execute on function app.org_accepts_at(uuid, timestamptz) to authenticated, service_role, tillflow_ops;

-- Whether the till's business is read-only (paused or closed), for the catalogue feed. The shop and
-- till come from the device token, never from what the till claims.
create function ops.device_billing_state(p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  return jsonb_build_object('read_only', not app.org_writable(d.org_id));
end
$$;
revoke all on function ops.device_billing_state(text) from public, anon, authenticated;
grant execute on function ops.device_billing_state(text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- RLS
insert into public.billing_counters (name, last_no) values ('invoice', 0);

alter table public.subscriptions enable row level security;
alter table public.billing_invoices enable row level security;
alter table public.billing_counters enable row level security;
alter table public.platform_admins enable row level security;
revoke all on public.subscriptions, public.billing_invoices, public.billing_counters, public.platform_admins
  from anon, authenticated;
grant select on public.subscriptions to authenticated;
-- Owners do not get the bank statement text (bank_reference), who marked it paid, or email stamps.
grant select (id, org_id, invoice_no, period_start, period_end, amount_ex_vat_cents, vat_rate_bp,
              vat_cents, total_cents, issued_at, due_on, payment_reference, status, paid_at, paid_on,
              supplier_name, supplier_address, supplier_vat_number, customer_name, customer_address,
              customer_vat_number, created_at)
  on public.billing_invoices to authenticated;

create policy subscriptions_select on public.subscriptions for select to authenticated
  using (org_id in (select app.owner_org_ids()));
create policy billing_invoices_select on public.billing_invoices for select to authenticated
  using (org_id in (select app.owner_org_ids()));
create policy billing_counters_deny_all on public.billing_counters as restrictive for all
  to anon, authenticated using (false) with check (false);
create policy platform_admins_deny_all on public.platform_admins as restrictive for all
  to anon, authenticated using (false) with check (false);

-- ---------------------------------------------------------------- invoice immutability
create function app.billing_invoice_guard() returns trigger
language plpgsql set search_path = ''
as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'invoices are never deleted' using errcode = '42501';
  end if;
  if (new.id, new.org_id, new.invoice_no, new.period_start, new.period_end, new.amount_ex_vat_cents,
      new.vat_rate_bp, new.vat_cents, new.total_cents, new.issued_at, new.due_on, new.payment_reference,
      new.created_at, new.supplier_name, new.supplier_address, new.supplier_vat_number,
      new.customer_name, new.customer_address, new.customer_vat_number)
     is distinct from
     (old.id, old.org_id, old.invoice_no, old.period_start, old.period_end, old.amount_ex_vat_cents,
      old.vat_rate_bp, old.vat_cents, old.total_cents, old.issued_at, old.due_on, old.payment_reference,
      old.created_at, old.supplier_name, old.supplier_address, old.supplier_vat_number,
      old.customer_name, old.customer_address, old.customer_vat_number) then
    raise exception 'an issued invoice cannot be changed' using errcode = '42501';
  end if;
  if old.status <> 'issued' and new is distinct from old then
    raise exception 'a paid or void invoice cannot be changed' using errcode = '42501';
  end if;
  if old.status = 'issued' and new.status = 'issued'
     and (new.paid_at, new.paid_on, new.bank_reference, new.marked_paid_by)
         is distinct from (old.paid_at, old.paid_on, old.bank_reference, old.marked_paid_by) then
    raise exception 'payment details are set only when marking paid' using errcode = '42501';
  end if;
  return new;
end
$$;
create trigger billing_invoices_guard before update or delete on public.billing_invoices
  for each row execute function app.billing_invoice_guard();
create trigger billing_invoices_no_truncate before truncate on public.billing_invoices
  for each statement execute function app.billing_invoice_guard();

-- ---------------------------------------------------------------- ops.billing_ensure_subscriptions
-- Gives every business that has no subscription row one (trial) and a trial end date. A business
-- that already existed gets the full trial from now, never a trial that ended in the past.
create function ops.billing_ensure_subscriptions(p_trial_days int, p_price_cents int) returns int
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_count int;
begin
  if p_trial_days is null or p_trial_days < 0 or p_price_cents is null or p_price_cents < 0 then
    raise exception 'bad billing settings' using errcode = '22023';
  end if;
  with fresh as (
    insert into public.subscriptions (id, org_id, status, price_cents)
    select gen_random_uuid(), o.id, 'trial', p_price_cents
      from public.organisations o
     where o.status in ('trial', 'active')
       and not exists (select 1 from public.subscriptions s where s.org_id = o.id)
    returning org_id
  )
  update public.organisations o
     set trial_ends_at = coalesce(
           o.trial_ends_at,
           case when o.created_at + make_interval(days => p_trial_days) > now()
                then o.created_at + make_interval(days => p_trial_days)
                else now() + make_interval(days => p_trial_days) end)
    from fresh f
   where o.id = f.org_id;
  get diagnostics v_count = row_count;
  return v_count;
end
$$;

-- ---------------------------------------------------------------- ops.billing_candidates
-- Businesses that may need their next invoice: not paused, not closed, nothing unpaid already.
-- The job (TypeScript) works out the period from these facts.
create function ops.billing_candidates() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'org_id', s.org_id,
           'sub_status', s.status,
           'anchor_date', s.anchor_date,
           'resumed_on', s.resumed_on,
           'trial_ends_at', o.trial_ends_at,
           'last_period_start', (select max(i.period_start) from public.billing_invoices i
                                  where i.org_id = s.org_id and i.status <> 'void')) order by s.org_id),
         '[]'::jsonb)
    from public.subscriptions s
    join public.organisations o on o.id = s.org_id
   where s.status <> 'paused'
     and o.status in ('trial', 'active')
     and not exists (select 1 from public.billing_invoices i where i.org_id = s.org_id and i.status = 'issued')
$$;

-- ---------------------------------------------------------------- ops.billing_issue_invoice
-- Creates one invoice. Idempotent per (business, period). p carries every figure; nothing is
-- computed here except the invoice number. Raises unique_violation (23505) on a reference clash:
-- the whole call, counter included, rolls back, and the caller tries a new reference.
create function ops.billing_issue_invoice(p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_id uuid := (p ->> 'id')::uuid;
  v_start date := (p ->> 'period_start')::date;
  v_end date := (p ->> 'period_end')::date;
  v_ex int := (p ->> 'amount_ex_vat_cents')::int;
  v_rate int := (p ->> 'vat_rate_bp')::int;
  v_vat int := (p ->> 'vat_cents')::int;
  v_total int := (p ->> 'total_cents')::int;
  v_due date := (p ->> 'due_on')::date;
  v_ref text := p ->> 'payment_reference';
  v_sup_name text := btrim(coalesce(p ->> 'supplier_name', ''));
  v_sup_addr text := btrim(coalesce(p ->> 'supplier_address', ''));
  v_sup_vat text := btrim(coalesce(p ->> 'supplier_vat_number', ''));
  v_cust_name text;
  v_cust_addr text;
  v_cust_vat text;
  v_existing public.billing_invoices%rowtype;
  v_no int;
begin
  if num_nulls(v_org, v_id, v_start, v_end, v_ex, v_rate, v_vat, v_total, v_due, v_ref) > 0 then
    raise exception 'invoice figures are required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.subscriptions s where s.org_id = v_org) then
    raise exception 'no subscription' using errcode = '22023';
  end if;
  if v_sup_name = '' or v_sup_addr = '' or v_sup_vat = '' then
    raise exception 'supplier details are required' using errcode = '22023';
  end if;
  if not app.billing_reference_valid(v_ref) then
    raise exception 'bad payment reference' using errcode = '22023';
  end if;
  -- VAT must be exactly net x rate rounded half up (the TypeScript addVat rule), nothing else.
  if v_total <> v_ex + v_vat or v_ex < 0 or v_vat < 0 or v_rate not between 0 and 10000
     or v_vat::bigint <> (v_ex::bigint * v_rate + 5000) / 10000 then
    raise exception 'invoice figures do not add up' using errcode = '22023';
  end if;

  -- One counter row, locked until this transaction ends: numbers are handed out one at a time.
  perform 1 from public.billing_counters where name = 'invoice' for update;

  select * into v_existing from public.billing_invoices
   where org_id = v_org and period_start = v_start;
  if found then
    return jsonb_build_object('created', false, 'id', v_existing.id,
                              'invoice_no', v_existing.invoice_no,
                              'payment_reference', v_existing.payment_reference);
  end if;

  -- The customer as they are today, kept on the invoice for good (a reprint must match the original).
  select coalesce(o.legal_name, o.name), o.vat_number into v_cust_name, v_cust_vat
    from public.organisations o where o.id = v_org;
  select nullif(btrim(l.address), '') into v_cust_addr from public.locations l
   where l.org_id = v_org order by l.created_at limit 1;

  update public.billing_counters set last_no = last_no + 1 where name = 'invoice' returning last_no into v_no;
  insert into public.billing_invoices
    (id, org_id, invoice_no, period_start, period_end, amount_ex_vat_cents, vat_rate_bp, vat_cents,
     total_cents, due_on, payment_reference, supplier_name, supplier_address, supplier_vat_number,
     customer_name, customer_address, customer_vat_number)
  values (v_id, v_org, v_no, v_start, v_end, v_ex, v_rate, v_vat, v_total, v_due, v_ref,
          v_sup_name, v_sup_addr, v_sup_vat, v_cust_name, v_cust_addr, v_cust_vat);
  -- The first invoice after a pause starts on the day the business was reopened (the months it was
  -- paused are not billed), so the monthly cycle is counted from that day from now on.
  update public.subscriptions
     set anchor_date = case when resumed_on is not null and v_start = resumed_on then v_start
                            else coalesce(anchor_date, v_start) end,
         resumed_on = case when resumed_on is not null and v_start >= resumed_on then null else resumed_on end,
         price_cents = v_ex, updated_at = now()
   where org_id = v_org;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (gen_random_uuid(), v_org, null, 'billing.invoice_issued', 'billing_invoice', v_id,
          jsonb_build_object('invoice_no', v_no, 'total_cents', v_total, 'period_start', v_start));
  return jsonb_build_object('created', true, 'id', v_id, 'invoice_no', v_no, 'payment_reference', v_ref);
end
$$;

-- ---------------------------------------------------------------- invoice emails and reminders
create function ops.billing_pending_emails() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(i.id order by i.issued_at), '[]'::jsonb)
    from (select id, issued_at from public.billing_invoices
           where status = 'issued' and emailed_at is null order by issued_at limit 100) i
$$;

create function ops.billing_mark_emailed(p_invoice uuid) returns void
language sql volatile security definer set search_path = ''
as $$
  update public.billing_invoices set emailed_at = now()
   where id = p_invoice and status = 'issued' and emailed_at is null
$$;

-- Everything the invoice email and PDF need. The owners' addresses come from the login accounts
-- (auth.users), like ops.shift_z_email_data: a swap point if the auth provider changes.
create function ops.billing_invoice_context(p_invoice uuid) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select jsonb_build_object(
    'invoice', to_jsonb(i),
    'org_name', o.name, 'legal_name', o.legal_name, 'vat_number', o.vat_number,
    'sub_status', s.status,
    'emails', coalesce((
      select jsonb_agg(distinct lower(u.email))
        from public.memberships m join auth.users u on u.id = m.user_id
       where m.org_id = i.org_id and m.role = 'owner' and u.email is not null), '[]'::jsonb))
    from public.billing_invoices i
    join public.organisations o on o.id = i.org_id
    left join public.subscriptions s on s.org_id = i.org_id
   where i.id = p_invoice
$$;

create function ops.billing_open_invoices() returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', i.id, 'org_id', i.org_id, 'due_on', i.due_on,
           'reminder_1_sent', i.reminder_1_sent_at is not null,
           'reminder_2_sent', i.reminder_2_sent_at is not null,
           'sub_status', s.status, 'org_status', o.status) order by i.due_on), '[]'::jsonb)
    from public.billing_invoices i
    join public.organisations o on o.id = i.org_id
    left join public.subscriptions s on s.org_id = i.org_id
   where i.status = 'issued'
$$;

-- Claims a reminder: true exactly once per invoice and number, so two workers never both send it.
create function ops.billing_reminder_claim(p_invoice uuid, p_n int) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_done boolean;
begin
  if p_n not in (1, 2) then
    raise exception 'reminder number must be 1 or 2' using errcode = '22023';
  end if;
  if p_n = 1 then
    update public.billing_invoices set reminder_1_sent_at = now()
     where id = p_invoice and status = 'issued' and reminder_1_sent_at is null returning true into v_done;
  else
    update public.billing_invoices set reminder_2_sent_at = now()
     where id = p_invoice and status = 'issued' and reminder_2_sent_at is null returning true into v_done;
  end if;
  return coalesce(v_done, false);
end
$$;

-- Hands a claim back when the email could not be sent, so the next run tries again.
create function ops.billing_reminder_release(p_invoice uuid, p_n int) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_n = 1 then
    update public.billing_invoices set reminder_1_sent_at = null where id = p_invoice and status = 'issued';
  elsif p_n = 2 then
    update public.billing_invoices set reminder_2_sent_at = null where id = p_invoice and status = 'issued';
  end if;
end
$$;

-- ---------------------------------------------------------------- overdue and pause
create function ops.billing_mark_overdue(p_org uuid) returns void
language sql volatile security definer set search_path = ''
as $$
  update public.subscriptions set status = 'overdue', updated_at = now()
   where org_id = p_org and status in ('trial', 'active')
     and (hold_until is null or hold_until < (now() at time zone 'Europe/Dublin')::date)
$$;

-- Pauses a business that is still unpaid after the grace days. Returns true only when it did.
-- A super-admin's unpause sets hold_until, so the job does not pause the business again at once.
create function ops.billing_pause(p_org uuid, p_invoice uuid, p_today date) returns boolean
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_hold date;
begin
  -- Subscription lock first (as mark paid and unpause do), THEN look at the invoice: a payment that
  -- committed while this waited for the lock must be seen, or a business that just paid gets paused.
  select s.hold_until into v_hold from public.subscriptions s where s.org_id = p_org for update;
  if not found or (v_hold is not null and v_hold >= p_today) then
    return false;
  end if;
  if not exists (select 1 from public.billing_invoices i
                  where i.id = p_invoice and i.org_id = p_org and i.status = 'issued') then
    return false;
  end if;
  update public.organisations set status = 'read_only', updated_at = now()
   where id = p_org and status in ('trial', 'active');
  if not found then
    return false;
  end if;
  update public.subscriptions set status = 'paused', paused_at = now(), updated_at = now() where org_id = p_org;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (gen_random_uuid(), p_org, null, 'billing.paused', 'billing_invoice', p_invoice,
          jsonb_build_object('today', p_today));
  return true;
end
$$;

-- ---------------------------------------------------------------- public.admin_*
create function public.admin_list_invoices(p_filter text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'Europe/Dublin')::date;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_filter is null or p_filter not in ('outstanding', 'overdue', 'paid') then
    raise exception 'unknown filter' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.sort_key desc)
      from (
        select i.id, i.org_id, o.name as org_name, o.status as org_status, s.status as sub_status,
               i.invoice_no, i.total_cents, i.due_on, i.payment_reference, i.status, i.paid_on,
               i.bank_reference, i.issued_at,
               case when i.status = 'paid' then i.paid_at else i.due_on::timestamptz end as sort_key
          from public.billing_invoices i
          join public.organisations o on o.id = i.org_id
          left join public.subscriptions s on s.org_id = i.org_id
         where case p_filter
                 when 'paid' then i.status = 'paid'
                 when 'overdue' then i.status = 'issued' and i.due_on < v_today
                 else i.status = 'issued' and i.due_on >= v_today end
         limit 500) x), '[]'::jsonb);
end
$$;

create function public.admin_mark_paid(p_invoice uuid, p_bank_reference text, p_paid_on date) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := (select app.current_user_id());
  v_today date := (now() at time zone 'Europe/Dublin')::date;
  v_ref text := btrim(coalesce(p_bank_reference, ''));
  v_inv public.billing_invoices%rowtype;
  v_was_paused boolean;
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_ref) < 3 or char_length(v_ref) > 100 then
    raise exception 'bank reference must be 3 to 100 characters' using errcode = '22023';
  end if;
  select * into v_inv from public.billing_invoices where id = p_invoice for update;
  if not found then
    raise exception 'no such invoice' using errcode = '22023';
  end if;
  if v_inv.status <> 'issued' then
    raise exception 'invoice is not outstanding' using errcode = '22023';
  end if;
  if p_paid_on is null or p_paid_on > v_today or p_paid_on < (v_inv.issued_at at time zone 'Europe/Dublin')::date then
    raise exception 'paid date must be between the issue date and today' using errcode = '22023';
  end if;

  select (o.status = 'read_only') into v_was_paused from public.organisations o where o.id = v_inv.org_id;
  update public.billing_invoices
     set status = 'paid', paid_at = now(), paid_on = p_paid_on, bank_reference = v_ref, marked_paid_by = v_actor
   where id = p_invoice;
  update public.subscriptions
     set status = 'active', period_start = v_inv.period_start, period_end = v_inv.period_end,
         paused_at = null, hold_until = null,
         -- paying while paused reopens the business today; the paused months are not billed
         resumed_on = case when coalesce(v_was_paused, false) then v_today else resumed_on end,
         updated_at = now()
   where org_id = v_inv.org_id;
  update public.organisations set status = 'active', updated_at = now()
   where id = v_inv.org_id and status in ('trial', 'read_only');
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, before, after)
  values (gen_random_uuid(), v_inv.org_id, v_actor, 'billing.marked_paid', 'billing_invoice', p_invoice,
          jsonb_build_object('status', 'issued'),
          jsonb_build_object('status', 'paid', 'invoice_no', v_inv.invoice_no,
                             'total_cents', v_inv.total_cents, 'paid_on', p_paid_on));
end
$$;

create function public.admin_unpause(p_org uuid, p_note text, p_hold_days int) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_actor uuid := (select app.current_user_id());
  v_today date := (now() at time zone 'Europe/Dublin')::date;
  v_note text := btrim(coalesce(p_note, ''));
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if char_length(v_note) < 5 or char_length(v_note) > 300 then
    raise exception 'a note of 5 to 300 characters is required' using errcode = '22023';
  end if;
  if p_hold_days is null or p_hold_days < 0 or p_hold_days > 365 then
    raise exception 'bad hold days' using errcode = '22023';
  end if;
  -- Same lock order as ops.billing_pause (subscription first), so the two cannot deadlock.
  perform 1 from public.subscriptions s where s.org_id = p_org for update;
  if not found then
    raise exception 'no such business' using errcode = '22023';
  end if;
  update public.organisations set status = 'active', updated_at = now()
   where id = p_org and status = 'read_only';
  if not found then
    raise exception 'business is not paused' using errcode = '22023';
  end if;
  update public.subscriptions
     set status = 'active', paused_at = null, hold_until = v_today + p_hold_days,
         resumed_on = v_today, updated_at = now()
   where org_id = p_org;
  -- The note is the reason; it is kept in the audit row (staff text, no customer data).
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (gen_random_uuid(), p_org, v_actor, 'billing.unpaused', 'organisation', p_org,
          jsonb_build_object('note', v_note, 'hold_until', v_today + p_hold_days));
end
$$;

-- Looks up invoices by payment reference for a bank-statement upload. Read-only: a person
-- confirms each match with admin_mark_paid, which is the audited step. (Lookups themselves are not
-- audit-logged: audit_log rows belong to one business and a lookup spans many.)
create function public.admin_match_references(p_refs text[]) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not (select app.is_platform_admin()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_refs is null or cardinality(p_refs) > 2000 then
    raise exception 'too many references' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'reference', i.payment_reference, 'invoice_id', i.id, 'org_name', o.name,
             'invoice_no', i.invoice_no, 'total_cents', i.total_cents, 'status', i.status, 'due_on', i.due_on))
      from public.billing_invoices i
      join public.organisations o on o.id = i.org_id
     where i.payment_reference = any (p_refs)), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------- grants
revoke all on function
  ops.billing_ensure_subscriptions(int, int), ops.billing_candidates(), ops.billing_issue_invoice(jsonb),
  ops.billing_pending_emails(), ops.billing_mark_emailed(uuid), ops.billing_invoice_context(uuid),
  ops.billing_open_invoices(), ops.billing_reminder_claim(uuid, int), ops.billing_reminder_release(uuid, int),
  ops.billing_mark_overdue(uuid), ops.billing_pause(uuid, uuid, date)
  from public, anon, authenticated;
grant execute on function
  ops.billing_ensure_subscriptions(int, int), ops.billing_candidates(), ops.billing_issue_invoice(jsonb),
  ops.billing_pending_emails(), ops.billing_mark_emailed(uuid), ops.billing_invoice_context(uuid),
  ops.billing_open_invoices(), ops.billing_reminder_claim(uuid, int), ops.billing_reminder_release(uuid, int),
  ops.billing_mark_overdue(uuid), ops.billing_pause(uuid, uuid, date)
  to service_role, tillflow_ops;

revoke all on function
  public.admin_list_invoices(text), public.admin_mark_paid(uuid, text, date),
  public.admin_unpause(uuid, text, int), public.admin_match_references(text[])
  from public, anon;
grant execute on function
  public.admin_list_invoices(text), public.admin_mark_paid(uuid, text, date),
  public.admin_unpause(uuid, text, int), public.admin_match_references(text[])
  to authenticated;

-- ---------------------------------------------------------------- read-only mode: till writes
-- The same wrapper pattern as shifts, customers and tabs: rename the current function and put a check
-- in front of it. A write made before the pause is still accepted when it syncs late.
alter function ops.record_sale(jsonb, text) rename to record_sale_billing;
revoke all on function ops.record_sale_billing(jsonb, text) from public, anon, authenticated, service_role, tillflow_ops;
create function ops.record_sale(p jsonb, p_token_hash text default null) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (p -> 'sale' ->> 'org_id')::uuid;
begin
  -- With a device token the business is the token's, not what the payload says (the inner function
  -- also checks they agree). Without one (a manager retrying from the back office) the payload is used.
  if p_token_hash is not null then
    v_org := coalesce((select d.org_id from app.device_register(p_token_hash) d), v_org);
  end if;
  if not app.org_accepts_at(v_org, (p -> 'sale' ->> 'completed_at')::timestamptz) then
    raise exception 'this business is paused' using errcode = 'TF004';
  end if;
  return ops.record_sale_billing(p, p_token_hash);
end
$$;
revoke all on function ops.record_sale(jsonb, text) from public, anon, authenticated;
grant execute on function ops.record_sale(jsonb, text) to service_role, tillflow_ops;

alter function ops.record_refund(jsonb, text) rename to record_refund_billing;
revoke all on function ops.record_refund_billing(jsonb, text) from public, anon, authenticated, service_role, tillflow_ops;
create function ops.record_refund(p jsonb, p_token_hash text) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (p -> 'refund' ->> 'org_id')::uuid;
begin
  if p_token_hash is not null then
    v_org := coalesce((select d.org_id from app.device_register(p_token_hash) d), v_org);
  end if;
  if not app.org_accepts_at(v_org, (p -> 'refund' ->> 'completed_at')::timestamptz) then
    raise exception 'this business is paused' using errcode = 'TF004';
  end if;
  return ops.record_refund_billing(p, p_token_hash);
end
$$;
revoke all on function ops.record_refund(jsonb, text) from public, anon, authenticated;
grant execute on function ops.record_refund(jsonb, text) to service_role, tillflow_ops;

-- Opening a shift and cash in/out are writes; closing one is allowed so a day that was open when
-- the business was paused can still be ended and its Z produced.
alter function ops.record_shift_event(text, jsonb) rename to record_shift_event_billing;
revoke all on function ops.record_shift_event_billing(text, jsonb) from public, anon, authenticated, service_role, tillflow_ops;
create function ops.record_shift_event(p_token_hash text, e jsonb) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (e ->> 'org_id')::uuid;
begin
  if p_token_hash is not null then
    v_org := coalesce((select d.org_id from app.device_register(p_token_hash) d), v_org);
  end if;
  if (e ->> 'kind') in ('open', 'cash')
     and not app.org_accepts_at(v_org, (e ->> 'at')::timestamptz) then
    raise exception 'this business is paused' using errcode = 'TF004';
  end if;
  return ops.record_shift_event_billing(p_token_hash, e);
end
$$;
revoke all on function ops.record_shift_event(text, jsonb) from public, anon, authenticated;
grant execute on function ops.record_shift_event(text, jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- read-only mode: back-office writes
-- SECURITY DEFINER functions that clients can call: same wrapper, and the inner function is closed
-- to clients so the check cannot be skipped.
alter function public.save_customer(uuid, uuid, jsonb) rename to save_customer_billing;
revoke all on function public.save_customer_billing(uuid, uuid, jsonb) from public, anon, authenticated;
create function public.save_customer(p_org uuid, p_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable(p_org) then
    perform app.refuse_paused(p_org);
  end if;
  return public.save_customer_billing(p_org, p_id, p);
end
$$;
revoke all on function public.save_customer(uuid, uuid, jsonb) from public, anon;
grant execute on function public.save_customer(uuid, uuid, jsonb) to authenticated;

alter function public.confirm_import(uuid, uuid, text, text, jsonb) rename to confirm_import_billing;
revoke all on function public.confirm_import_billing(uuid, uuid, text, text, jsonb) from public, anon, authenticated;
create function public.confirm_import(p_org uuid, p_id uuid, p_mode text, p_match_key text, p_mapping jsonb)
returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable(p_org) then
    perform app.refuse_paused(p_org);
  end if;
  perform public.confirm_import_billing(p_org, p_id, p_mode, p_match_key, p_mapping);
end
$$;
revoke all on function public.confirm_import(uuid, uuid, text, text, jsonb) from public, anon;
grant execute on function public.confirm_import(uuid, uuid, text, text, jsonb) to authenticated;

-- Tables the back office writes directly or through SECURITY INVOKER functions (save_product,
-- save_modifier_group, adjust_stock): a restrictive policy refuses inserts and updates for a
-- paused or closed business, whatever the permissive policies say.
do $$
declare
  t text;
begin
  foreach t in array array['products', 'variants', 'variant_costs', 'stock_movements', 'categories',
                           'modifier_groups', 'modifiers', 'product_modifier_groups']
  loop
    execute format('create policy %I on public.%I as restrictive for insert to authenticated
                    with check (app.org_writable(org_id))', t || '_org_writable_ins', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated
                    using (app.org_writable(org_id)) with check (app.org_writable(org_id))',
                   t || '_org_writable_upd', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated
                    using (app.org_writable(org_id))', t || '_org_writable_del', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------- read-only mode: settings and staff
-- Policy (owner, 2026-10-17): while paused nothing that changes how the shop trades may be saved.
--   blocked:    tender types, floor plan, service charge, discount and refund limits, new till
--               pairing codes, adding till staff, tab events from a till, creating a customer at the till
--   owner only: revoking a till, removing till staff, setting or resetting a till PIN (these reduce
--               access or fix a lockout, so they stay possible, but never for a manager)
-- Allowed: reading, report downloads, the account export, invoices, closing an open shift, a
-- person's own PIN and two-step settings, and register events (the audit trail of drawer opens).
create function app.org_writable_or_owner(p_org uuid) returns boolean
language sql stable security definer set search_path = ''
as $$
  select app.org_writable(p_org) or p_org in (select app.owner_org_ids())
$$;
revoke all on function app.org_writable_or_owner(uuid) from public;
grant execute on function app.org_writable_or_owner(uuid) to authenticated;

do $$
declare
  t text;
begin
  foreach t in array array['tender_types', 'floors', 'restaurant_tables']
  loop
    execute format('create policy %I on public.%I as restrictive for insert to authenticated
                    with check (app.org_writable(org_id))', t || '_org_writable_ins', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated
                    using (app.org_writable(org_id)) with check (app.org_writable(org_id))',
                   t || '_org_writable_upd', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated
                    using (app.org_writable(org_id))', t || '_org_writable_del', t);
  end loop;
end
$$;

-- Business-keyed functions: blocked while paused.
alter function public.save_floor_plan(uuid, jsonb) rename to save_floor_plan_billing;
revoke all on function public.save_floor_plan_billing(uuid, jsonb) from public, anon, authenticated;
create function public.save_floor_plan(p_org uuid, p_floors jsonb) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable(p_org) then
    perform app.refuse_paused(p_org);
  end if;
  perform public.save_floor_plan_billing(p_org, p_floors);
end
$$;
revoke all on function public.save_floor_plan(uuid, jsonb) from public, anon;
grant execute on function public.save_floor_plan(uuid, jsonb) to authenticated;

alter function public.set_service_charge(uuid, integer, uuid) rename to set_service_charge_billing;
revoke all on function public.set_service_charge_billing(uuid, integer, uuid) from public, anon, authenticated;
create function public.set_service_charge(p_org uuid, p_bp integer, p_audit_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable(p_org) then
    perform app.refuse_paused(p_org);
  end if;
  perform public.set_service_charge_billing(p_org, p_bp, p_audit_id);
end
$$;
revoke all on function public.set_service_charge(uuid, integer, uuid) from public, anon;
grant execute on function public.set_service_charge(uuid, integer, uuid) to authenticated;

alter function public.set_discount_override(uuid, integer, uuid) rename to set_discount_override_billing;
revoke all on function public.set_discount_override_billing(uuid, integer, uuid) from public, anon, authenticated;
create function public.set_discount_override(p_org uuid, p_bp integer, p_audit_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable(p_org) then
    perform app.refuse_paused(p_org);
  end if;
  perform public.set_discount_override_billing(p_org, p_bp, p_audit_id);
end
$$;
revoke all on function public.set_discount_override(uuid, integer, uuid) from public, anon;
grant execute on function public.set_discount_override(uuid, integer, uuid) to authenticated;

alter function public.set_refund_override(uuid, integer, uuid) rename to set_refund_override_billing;
revoke all on function public.set_refund_override_billing(uuid, integer, uuid) from public, anon, authenticated;
create function public.set_refund_override(p_org uuid, p_cents integer, p_audit_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable(p_org) then
    perform app.refuse_paused(p_org);
  end if;
  perform public.set_refund_override_billing(p_org, p_cents, p_audit_id);
end
$$;
revoke all on function public.set_refund_override(uuid, integer, uuid) from public, anon;
grant execute on function public.set_refund_override(uuid, integer, uuid) to authenticated;

alter function public.add_till_staff(uuid, uuid, text, text, uuid) rename to add_till_staff_billing;
revoke all on function public.add_till_staff_billing(uuid, uuid, text, text, uuid) from public, anon, authenticated;
create function public.add_till_staff(p_org uuid, p_membership_id uuid, p_display_name text, p_pin_hash text, p_audit_id uuid)
returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable(p_org) then
    perform app.refuse_paused(p_org);
  end if;
  return public.add_till_staff_billing(p_org, p_membership_id, p_display_name, p_pin_hash, p_audit_id);
end
$$;
revoke all on function public.add_till_staff(uuid, uuid, text, text, uuid) from public, anon;
grant execute on function public.add_till_staff(uuid, uuid, text, text, uuid) to authenticated;

-- Till-keyed: a new pairing code is blocked; revoking a till stays possible for owners.
alter function public.create_pairing_code(uuid, text, uuid) rename to create_pairing_code_billing;
revoke all on function public.create_pairing_code_billing(uuid, text, uuid) from public, anon, authenticated;
create function public.create_pairing_code(p_register uuid, p_code_hash text, p_audit_id uuid) returns timestamptz
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable((select r.org_id from public.registers r where r.id = p_register)) then
    perform app.refuse_paused((select r.org_id from public.registers r where r.id = p_register));
  end if;
  return public.create_pairing_code_billing(p_register, p_code_hash, p_audit_id);
end
$$;
revoke all on function public.create_pairing_code(uuid, text, uuid) from public, anon;
grant execute on function public.create_pairing_code(uuid, text, uuid) to authenticated;

alter function public.revoke_register(uuid, uuid) rename to revoke_register_billing;
revoke all on function public.revoke_register_billing(uuid, uuid) from public, anon, authenticated;
create function public.revoke_register(p_register uuid, p_audit_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable_or_owner((select r.org_id from public.registers r where r.id = p_register)) then
    perform app.refuse_paused((select r.org_id from public.registers r where r.id = p_register));
  end if;
  perform public.revoke_register_billing(p_register, p_audit_id);
end
$$;
revoke all on function public.revoke_register(uuid, uuid) from public, anon;
grant execute on function public.revoke_register(uuid, uuid) to authenticated;

-- Membership-keyed PIN and staff changes: owner only while paused.
alter function public.set_member_pin(uuid, text, uuid) rename to set_member_pin_billing;
revoke all on function public.set_member_pin_billing(uuid, text, uuid) from public, anon, authenticated;
create function public.set_member_pin(p_membership uuid, p_hash text, p_audit_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable_or_owner((select m.org_id from public.memberships m where m.id = p_membership)) then
    perform app.refuse_paused((select m.org_id from public.memberships m where m.id = p_membership));
  end if;
  perform public.set_member_pin_billing(p_membership, p_hash, p_audit_id);
end
$$;
revoke all on function public.set_member_pin(uuid, text, uuid) from public, anon;
grant execute on function public.set_member_pin(uuid, text, uuid) to authenticated;

alter function public.remove_till_staff(uuid, uuid) rename to remove_till_staff_billing;
revoke all on function public.remove_till_staff_billing(uuid, uuid) from public, anon, authenticated;
create function public.remove_till_staff(p_membership uuid, p_audit_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable_or_owner((select m.org_id from public.memberships m where m.id = p_membership)) then
    perform app.refuse_paused((select m.org_id from public.memberships m where m.id = p_membership));
  end if;
  perform public.remove_till_staff_billing(p_membership, p_audit_id);
end
$$;
revoke all on function public.remove_till_staff(uuid, uuid) from public, anon;
grant execute on function public.remove_till_staff(uuid, uuid) to authenticated;

alter function public.reset_member_pin(uuid, uuid) rename to reset_member_pin_billing;
revoke all on function public.reset_member_pin_billing(uuid, uuid) from public, anon, authenticated;
create function public.reset_member_pin(p_membership uuid, p_audit_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable_or_owner((select m.org_id from public.memberships m where m.id = p_membership)) then
    perform app.refuse_paused((select m.org_id from public.memberships m where m.id = p_membership));
  end if;
  perform public.reset_member_pin_billing(p_membership, p_audit_id);
end
$$;
revoke all on function public.reset_member_pin(uuid, uuid) from public, anon;
grant execute on function public.reset_member_pin(uuid, uuid) to authenticated;

-- Token-keyed till writes. The business is the token's, as in the sale wrapper.
alter function ops.record_tab_event(text, jsonb) rename to record_tab_event_billing;
revoke all on function ops.record_tab_event_billing(text, jsonb) from public, anon, authenticated, service_role, tillflow_ops;
create function ops.record_tab_event(p_token_hash text, p jsonb) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (select d.org_id from app.device_register(p_token_hash) d);
begin
  if v_org is not null and not app.org_writable(v_org) then
    raise exception 'this business is paused' using errcode = 'TF004';
  end if;
  return ops.record_tab_event_billing(p_token_hash, p);
end
$$;
revoke all on function ops.record_tab_event(text, jsonb) from public, anon, authenticated;
grant execute on function ops.record_tab_event(text, jsonb) to service_role, tillflow_ops;

alter function ops.device_customer_create(text, jsonb) rename to device_customer_create_billing;
revoke all on function ops.device_customer_create_billing(text, jsonb) from public, anon, authenticated, service_role, tillflow_ops;
create function ops.device_customer_create(p_token_hash text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (select d.org_id from app.device_register(p_token_hash) d);
begin
  if v_org is not null and not app.org_writable(v_org) then
    raise exception 'this business is paused' using errcode = 'TF004';
  end if;
  return ops.device_customer_create_billing(p_token_hash, p);
end
$$;
revoke all on function ops.device_customer_create(text, jsonb) from public, anon, authenticated;
grant execute on function ops.device_customer_create(text, jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- close the older inner layers
-- Earlier wrapper rounds (shifts, customers, restaurant) renamed record_sale / record_refund to
-- *_core / *_shifted / *_customer without closing them, and a rename keeps the grants. They would let
-- the jobs or service role skip the paused check, so they are closed now: only the outer functions
-- (and the layers that call each other as the function owner) can reach them.
revoke all on function
  ops.record_sale_core(jsonb, text), ops.record_refund_core(jsonb, text),
  ops.record_sale_shifted(jsonb, text), ops.record_sale_customer(jsonb, text)
  from public, anon, authenticated, service_role, tillflow_ops;

-- The public inner functions: same as the ops ones, not even the service role.
revoke all on function
  public.save_floor_plan_billing(uuid, jsonb), public.set_service_charge_billing(uuid, integer, uuid),
  public.set_discount_override_billing(uuid, integer, uuid), public.set_refund_override_billing(uuid, integer, uuid),
  public.add_till_staff_billing(uuid, uuid, text, text, uuid), public.create_pairing_code_billing(uuid, text, uuid),
  public.revoke_register_billing(uuid, uuid), public.set_member_pin_billing(uuid, text, uuid),
  public.remove_till_staff_billing(uuid, uuid), public.reset_member_pin_billing(uuid, uuid),
  public.save_customer_billing(uuid, uuid, jsonb), public.confirm_import_billing(uuid, uuid, text, text, jsonb)
  from public, anon, authenticated, service_role;
