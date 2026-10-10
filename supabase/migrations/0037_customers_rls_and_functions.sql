-- Hand-written: RLS, append-only link and the customer functions (Phase 2, customers).
--
-- Customers hold personal data, so clients (managers and owners only) can SELECT and nothing else:
-- every write goes through a function that checks the role, validates and writes audit_log (ids
-- only, never names, emails or phones). A till reaches customers only through ops.device_* with its
-- device token. "Delete" is anonymise: the row is scrubbed and kept so past sales stay linked.

-- ---------------------------------------------------------------- RLS and grants
alter table public.customers enable row level security;
alter table public.sale_customers enable row level security;
revoke all on public.customers, public.sale_customers from anon, authenticated;
grant select on public.customers, public.sale_customers to authenticated;

create policy customers_select on public.customers for select to authenticated
  using (org_id in (select app.manager_org_ids()));
create policy sale_customers_select on public.sale_customers for select to authenticated
  using (org_id in (select app.manager_org_ids()));

create trigger customers_touch before update on public.customers
  for each row execute function app.touch_updated_at();
create trigger sale_customers_append_only before update or delete on public.sale_customers
  for each row execute function app.forbid_change();
create trigger sale_customers_no_truncate before truncate on public.sale_customers
  for each statement execute function app.forbid_change();

-- ---------------------------------------------------------------- app.clean_customer
-- One place that trims and checks the editable fields (used by the back office and the till).
create function app.clean_customer(p jsonb) returns jsonb
language plpgsql immutable set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(p ->> 'name', ''));
  v_email text := nullif(lower(btrim(coalesce(p ->> 'email', ''))), '');
  v_phone text := nullif(btrim(coalesce(p ->> 'phone', '')), '');
  v_vat text := nullif(upper(regexp_replace(coalesce(p ->> 'vat_number', ''), '\s', '', 'g')), '');
  v_address text := nullif(btrim(coalesce(p ->> 'address', '')), '');
  v_notes text := nullif(btrim(coalesce(p ->> 'notes', '')), '');
begin
  if char_length(v_name) not between 1 and 120 then
    raise exception 'name must be 1 to 120 characters' using errcode = '22023';
  end if;
  if v_email is not null and (char_length(v_email) > 254 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$') then
    raise exception 'email is not valid' using errcode = '22023';
  end if;
  if v_phone is not null and char_length(v_phone) > 30 then
    raise exception 'phone is too long' using errcode = '22023';
  end if;
  if v_vat is not null and v_vat !~ '^[A-Z]{2}[A-Z0-9]{2,18}$' then
    raise exception 'vat number is not valid' using errcode = '22023';
  end if;
  if char_length(coalesce(v_address, '')) > 300 or char_length(coalesce(v_notes, '')) > 500 then
    raise exception 'text is too long' using errcode = '22023';
  end if;
  return jsonb_build_object('name', v_name, 'email', v_email, 'phone', v_phone,
                            'vat_number', v_vat, 'address', v_address, 'notes', v_notes);
end
$$;
revoke all on function app.clean_customer(jsonb) from public, anon, authenticated;
grant execute on function app.clean_customer(jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- public.save_customer
-- Create (unknown id) or edit. Managers and owners. An anonymised customer cannot be edited.
create function public.save_customer(p_org uuid, p_id uuid, p jsonb) returns uuid
language plpgsql volatile security definer set search_path = ''
as $$
declare
  c jsonb;
  v_anonymised timestamptz;
  v_exists boolean;
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  c := app.clean_customer(p);
  select true, anonymised_at into v_exists, v_anonymised
    from public.customers where org_id = p_org and id = p_id;
  if v_exists then
    if v_anonymised is not null then
      raise exception 'customer is anonymised' using errcode = '22023';
    end if;
    update public.customers set name = c ->> 'name', email = c ->> 'email', phone = c ->> 'phone',
           vat_number = c ->> 'vat_number', address = c ->> 'address', notes = c ->> 'notes'
     where org_id = p_org and id = p_id;
  else
    insert into public.customers (id, org_id, name, email, phone, vat_number, address, notes)
    values (p_id, p_org, c ->> 'name', c ->> 'email', c ->> 'phone', c ->> 'vat_number',
            c ->> 'address', c ->> 'notes');
  end if;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, (select app.current_user_id()),
          case when v_exists then 'customer.updated' else 'customer.created' end, 'customer', p_id);
  return p_id;
end
$$;

-- ---------------------------------------------------------------- public.set_marketing_consent
-- The timestamp is the server's clock; clearing it withdraws consent (also audited).
create function public.set_marketing_consent(p_org uuid, p_id uuid, p_on boolean) returns timestamptz
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_at timestamptz := case when p_on then now() end;
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.customers set marketing_consent_at = v_at
   where org_id = p_org and id = p_id and anonymised_at is null;
  if not found then
    raise exception 'customer not found' using errcode = '22023';
  end if;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, (select app.current_user_id()),
          case when p_on then 'customer.consent_given' else 'customer.consent_withdrawn' end,
          'customer', p_id);
  return v_at;
end
$$;

-- ---------------------------------------------------------------- public.anonymise_customer
-- GDPR erasure that keeps the books: scrub every personal field, keep the id and the sale links.
-- Idempotent: a second call changes nothing and writes no second audit row.
create function public.anonymise_customer(p_org uuid, p_id uuid) returns void
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.customers
     set name = 'Deleted customer', email = null, phone = null, vat_number = null, address = null,
         notes = null, marketing_consent_at = null, anonymised_at = now()
   where org_id = p_org and id = p_id and anonymised_at is null;
  if found then
    insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
    values (gen_random_uuid(), p_org, (select app.current_user_id()), 'customer.anonymised',
            'customer', p_id);
  elsif not exists (select 1 from public.customers where org_id = p_org and id = p_id) then
    raise exception 'customer not found' using errcode = '22023';
  end if;
end
$$;

-- ---------------------------------------------------------------- public.export_customer
-- Everything held about one customer, for a data-access request. Audited on every call.
create function public.export_customer(p_org uuid, p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_out jsonb;
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'customer', jsonb_build_object('id', c.id, 'name', c.name, 'email', c.email, 'phone', c.phone,
      'vat_number', c.vat_number, 'address', c.address, 'notes', c.notes,
      'marketing_consent_at', c.marketing_consent_at, 'created_at', c.created_at,
      'anonymised_at', c.anonymised_at),
    'sales', coalesce((
      select jsonb_agg(jsonb_build_object('sale_id', s.id, 'receipt_seq', s.receipt_seq,
               'completed_at', s.completed_at, 'total_cents', s.amount_due_cents)
             order by s.completed_at)
        from public.sale_customers sc
        join public.sales s on s.org_id = sc.org_id and s.id = sc.sale_id
       where sc.org_id = c.org_id and sc.customer_id = c.id), '[]'::jsonb))
    into v_out
    from public.customers c where c.org_id = p_org and c.id = p_id;
  if v_out is null then
    raise exception 'customer not found' using errcode = '22023';
  end if;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), p_org, (select app.current_user_id()), 'customer.exported',
          'customer', p_id);
  return v_out;
end
$$;

revoke all on function public.save_customer(uuid, uuid, jsonb) from public, anon;
revoke all on function public.set_marketing_consent(uuid, uuid, boolean) from public, anon;
revoke all on function public.anonymise_customer(uuid, uuid) from public, anon;
revoke all on function public.export_customer(uuid, uuid) from public, anon;
grant execute on function public.save_customer(uuid, uuid, jsonb) to authenticated;
grant execute on function public.set_marketing_consent(uuid, uuid, boolean) to authenticated;
grant execute on function public.anonymise_customer(uuid, uuid) to authenticated;
grant execute on function public.export_customer(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- ops.device_customer_search
-- A paired till finds customers of its own shop by NAME only (2+ characters, 8 rows) and gets back
-- id, name and a masked hint (j***@example.com or ends 567): contact details are for managers (a cashier at the till is not a manager, and
-- matching on email or phone would let a cashier test whether an address is on file). Nothing is
-- returned for an anonymised customer. null: the token is not a paired till.
create function ops.device_customer_search(p_token_hash text, p_q text) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
  v_q text := btrim(coalesce(p_q, ''));
  v_like text;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  if char_length(v_q) < 2 or char_length(v_q) > 60 then
    return '[]'::jsonb;
  end if;
  v_like := '%' || replace(replace(replace(v_q, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name, 'hint', x.hint) order by x.name, x.id)
      from (select c.id, c.name,
                   -- Enough to tell two people with one name apart, not enough to contact them.
                   case when c.email is not null
                          then left(split_part(c.email, '@', 1), 1) || '***@' || split_part(c.email, '@', 2)
                        when c.phone is not null
                          then 'ends ' || right(regexp_replace(c.phone, 'D', '', 'g'), 3) end as hint
              from public.customers c
             where c.org_id = d.org_id and c.anonymised_at is null and c.name ilike v_like
             order by c.name, c.id limit 8) x), '[]'::jsonb);
end
$$;
revoke all on function ops.device_customer_search(text, text) from public, anon, authenticated;
grant execute on function ops.device_customer_search(text, text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.device_customer_create
-- A paired till adds a customer to its own shop. consent = true stamps the server clock. A taken
-- email raises 23505 (the route answers 409). Returns the new customer, or null if not paired.
create function ops.device_customer_create(p_token_hash text, p jsonb) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  c jsonb;
  v_id uuid := (p ->> 'id')::uuid;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  c := app.clean_customer(p);
  insert into public.customers (id, org_id, name, email, phone, vat_number, address, marketing_consent_at)
  values (v_id, d.org_id, c ->> 'name', c ->> 'email', c ->> 'phone', c ->> 'vat_number',
          c ->> 'address', case when coalesce((p ->> 'consent')::boolean, false) then now() end);
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id)
  values (gen_random_uuid(), d.org_id, null, 'customer.created', 'customer', v_id);
  return jsonb_build_object('id', v_id, 'name', c ->> 'name', 'email', c ->> 'email',
           'phone', c ->> 'phone', 'vat_number', c ->> 'vat_number');
end
$$;
revoke all on function ops.device_customer_create(text, jsonb) from public, anon, authenticated;
grant execute on function ops.device_customer_create(text, jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.record_sale: customer link
-- Wraps the shift wrapper from 0033. p -> 'customer_id' (optional) is linked when it is a live
-- customer of the sale's shop; otherwise the sale is recorded without a link (a sale is never
-- refused over its customer, and a customer anonymised meanwhile is simply not linked).
alter function ops.record_sale(jsonb, text) rename to record_sale_shifted;

create function ops.record_sale(p jsonb, p_token_hash text default null) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_customer uuid := nullif(p ->> 'customer_id', '')::uuid;
  v_org uuid := (p -> 'sale' ->> 'org_id')::uuid;
  v_res text;
begin
  v_res := ops.record_sale_shifted(p, p_token_hash);
  -- Only a NEW sale takes a link: a replay of an old sale id cannot attach a customer afterwards.
  if v_customer is not null and v_res = 'created'
     and exists (select 1 from public.customers
                  where org_id = v_org and id = v_customer and anonymised_at is null) then
    insert into public.sale_customers (sale_id, org_id, customer_id)
    values ((p -> 'sale' ->> 'id')::uuid, v_org, v_customer)
    on conflict do nothing;
  end if;
  return v_res;
end
$$;
revoke all on function ops.record_sale(jsonb, text) from public, anon, authenticated;
grant execute on function ops.record_sale(jsonb, text) to service_role, tillflow_ops;
