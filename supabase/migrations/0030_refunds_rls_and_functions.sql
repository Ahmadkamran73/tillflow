-- Hand-written: RLS, append-only triggers and the refund functions (Phase 2 step 2.2).
--
-- Refunds, voids and exchanges are written ONLY by ops.record_refund. The original sale is never
-- touched: a refund is new rows (refunds, refund_lines, refund_payments) plus a stock movement.
-- Clients get SELECT and nothing else. Amounts are recomputed here from the stored sale-line
-- snapshot, so VAT is always reversed at the ORIGINAL rate (src/lib/money/refund.ts is the twin).

-- ---------------------------------------------------------------- RLS and grants
alter table public.refunds enable row level security;
alter table public.refund_lines enable row level security;
alter table public.refund_payments enable row level security;
revoke all on public.refunds, public.refund_lines, public.refund_payments from anon, authenticated;
grant select on public.refunds, public.refund_lines, public.refund_payments to authenticated;

-- Managers and owners read every refund of the shop; a cashier reads only the refunds they rang.
create policy refunds_select on public.refunds for select to authenticated
  using (
    org_id in (select app.manager_org_ids())
    or (org_id in (select app.current_org_ids()) and cashier_user_id = (select app.current_user_id()))
  );
create policy refund_lines_select on public.refund_lines for select to authenticated
  using (org_id in (select app.current_org_ids()) and refund_id in (select r.id from public.refunds r));
create policy refund_payments_select on public.refund_payments for select to authenticated
  using (org_id in (select app.current_org_ids()) and refund_id in (select r.id from public.refunds r));

create trigger refunds_append_only before update or delete on public.refunds
  for each row execute function app.forbid_change();
create trigger refund_lines_append_only before update or delete on public.refund_lines
  for each row execute function app.forbid_change();
create trigger refund_payments_append_only before update or delete on public.refund_payments
  for each row execute function app.forbid_change();
create trigger refunds_no_truncate before truncate on public.refunds
  for each statement execute function app.forbid_change();
create trigger refund_lines_no_truncate before truncate on public.refund_lines
  for each statement execute function app.forbid_change();
create trigger refund_payments_no_truncate before truncate on public.refund_payments
  for each statement execute function app.forbid_change();

-- An exchange credit is spent once, and a sale is the target of at most one exchange.
create unique index payments_exchange_refund_key on public.payments (exchange_refund_id)
  where exchange_refund_id is not null;
create unique index refunds_exchange_sale_key on public.refunds (org_id, exchange_sale_id)
  where exchange_sale_id is not null;

-- ---------------------------------------------------------------- refund approval limit
create function public.set_refund_override(p_org uuid, p_cents integer, p_audit_id uuid)
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
  if p_cents is null or p_cents not between 0 and 1000000 then
    raise exception 'bad input' using errcode = '22023';
  end if;

  select refund_override_cents into v_before from public.organisations where id = p_org for update;
  update public.organisations set refund_override_cents = p_cents where id = p_org;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, before, after)
  values (p_audit_id, p_org, v_user, 'organisation.refund_override_changed', 'organisation', p_org,
          jsonb_build_object('cents', v_before), jsonb_build_object('cents', p_cents));
end
$$;
revoke all on function public.set_refund_override(uuid, integer, uuid) from public, anon;
grant execute on function public.set_refund_override(uuid, integer, uuid) to authenticated;

-- ---------------------------------------------------------------- public.refund_totals
-- What went back per payment type in a period (and the exchange credit applied), so the owner can
-- compare the card total with the terminal's report. SECURITY INVOKER: RLS applies; managers only.
create function public.refund_totals(p_org uuid, p_from timestamptz, p_to timestamptz)
returns table (method text, label text, refunds bigint, amount_cents bigint, tip_cents bigint)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  if p_org not in (select app.manager_org_ids()) then
    raise exception 'managers only' using errcode = '42501';
  end if;
  return query
  select p.method, coalesce(p.label, initcap(p.method)), count(*), sum(p.amount_cents)::bigint,
         sum(p.tip_cents)::bigint
  from public.refund_payments p
  join public.refunds r on r.org_id = p.org_id and r.id = p.refund_id
  where p.org_id = p_org and r.completed_at >= p_from and r.completed_at < p_to
  group by p.method, coalesce(p.label, initcap(p.method))
  order by p.method, 2;
end
$$;
revoke all on function public.refund_totals(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.refund_totals(uuid, timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------- ops.issue_approval (replaced)
-- A refund approval is for ONE sale and up to a value: a manager who enters their PIN for a 25.00
-- refund of one sale has approved that, not any refund in the shop. (Other purposes carry neither.)
drop function ops.issue_approval(text, uuid, text);
create function ops.issue_approval(
  p_token_hash text, p_user uuid, p_purpose text,
  p_sale uuid default null, p_max_cents integer default null
) returns uuid
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
  if (p_purpose = 'refund') <> (p_sale is not null and p_max_cents is not null)
     or (p_purpose <> 'refund' and (p_sale is not null or p_max_cents is not null))
     or p_max_cents < 0 then
    raise exception 'a refund approval names its sale and a value' using errcode = '22023';
  end if;
  if not app.is_manager(p_user, d.org_id) then
    raise exception 'not a manager' using errcode = '42501';
  end if;
  insert into public.register_approvals (id, org_id, register_id, approver_user_id, purpose, sale_id, max_cents)
  values (v_id, d.org_id, d.register_id, p_user, p_purpose, p_sale, p_max_cents);
  return v_id;
end
$$;
revoke all on function ops.issue_approval(text, uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function ops.issue_approval(text, uuid, text, uuid, integer) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.device_refund_meta
-- What a till needs to ring refunds: the shop's approval limit and the last refund number this
-- till used (so a re-paired till carries on after the server's numbers).
create function ops.device_refund_meta(p_token_hash text) returns jsonb
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
    'refund_override_cents', (select o.refund_override_cents from public.organisations o where o.id = d.org_id),
    'last_refund_seq', coalesce((select max(r.receipt_seq) from public.refunds r
                                  where r.org_id = d.org_id and r.register_id = d.register_id), 0));
end
$$;
revoke all on function ops.device_refund_meta(text) from public, anon, authenticated;
grant execute on function ops.device_refund_meta(text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.device_find_sale
-- Finds sales in the device's own org to refund: by id, by till + receipt number, or by serial.
-- Returns each sale with its lines (and how many units earlier refunds took), its payments and
-- what each method has already given back. No customer or invoice data, and no cashier ids. At
-- most 5 sales. `viewer` is the person serving at the till: a cashier finds the sales of THIS till
-- and their own; a manager or owner finds any sale of the shop.
create function ops.device_find_sale(p_token_hash text, p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
  v_by text := p_query ->> 'by';
  v_ids uuid[];
  v_viewer uuid := nullif(p_query ->> 'viewer', '')::uuid;
  v_role text;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  if v_viewer is null then
    -- The sync check itself (privileged, server side) reads the sale it is judging: no viewer.
    -- The lookup route always names the person serving, so a till cannot reach this branch.
    v_role := 'owner';
  else
    select m.role into v_role from public.memberships m
     where m.org_id = d.org_id and m.user_id = v_viewer;
    if v_role is null then
      raise exception 'not a member' using errcode = '42501';
    end if;
  end if;
  if v_by = 'id' then
    select array_agg(s.id) into v_ids from public.sales s
     where s.org_id = d.org_id and s.id = (p_query ->> 'id')::uuid;
  elsif v_by = 'receipt' then
    select array_agg(s.id) into v_ids from public.sales s
     where s.org_id = d.org_id and s.register_id = (p_query ->> 'register_id')::uuid
       and s.receipt_seq = (p_query ->> 'seq')::int;
  elsif v_by = 'serial' then
    select array_agg(x.id) into v_ids from (
      select s.id from public.sales s
       where s.org_id = d.org_id
         and exists (select 1 from public.sale_lines l
                      where l.org_id = s.org_id and l.sale_id = s.id
                        and lower(l.serial) = lower(p_query ->> 'serial'))
       order by s.completed_at desc limit 5) x;
  else
    raise exception 'bad query' using errcode = '22023';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'sale', jsonb_build_object(
          'id', s.id, 'register_id', s.register_id,
          'register_name', (select r.name from public.registers r where r.id = s.register_id and r.org_id = s.org_id),
          'receipt_seq', s.receipt_seq, 'completed_at', s.completed_at, 'mode', s.mode,
          'items_total', s.items_total_cents, 'vat', s.vat_cents, 'non_vat', s.non_vat_cents,
          'cash_rounding', s.cash_rounding_cents, 'amount_due', s.amount_due_cents),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object(
            'id', l.id, 'line_no', l.line_no, 'kind', l.kind, 'variant_id', l.variant_id,
            'name', l.name, 'qty', l.qty, 'unit_price', l.unit_price_cents, 'serial', l.serial,
            'discount', l.discount_cents, 'tax_category', l.tax_category, 'tax_rate_bp', l.tax_rate_bp,
            'net', l.net_cents, 'vat', l.vat_cents, 'gross', l.gross_cents,
            'refunded_qty', coalesce((select sum(rl.qty) from public.refund_lines rl
                                       where rl.org_id = l.org_id and rl.sale_line_id = l.id), 0))
            order by l.line_no), '[]'::jsonb)
          from public.sale_lines l where l.org_id = s.org_id and l.sale_id = s.id),
      'payments', (select coalesce(jsonb_agg(jsonb_build_object(
            'method', p.method, 'type_id', p.tender_type_id, 'label', p.label,
            'amount', p.amount_cents, 'tip', p.tip_cents) order by p.created_at), '[]'::jsonb)
          from public.payments p where p.org_id = s.org_id and p.sale_id = s.id),
      'refunded', (select jsonb_build_object(
            'cash', coalesce(sum(rp.amount_cents) filter (where rp.method = 'cash'), 0),
            'card', coalesce(sum(rp.amount_cents) filter (where rp.method = 'card'), 0),
            'voucher', coalesce(sum(rp.amount_cents) filter (where rp.method = 'voucher'), 0),
            -- what earlier refunds are worth (items + deposits), for the approval limit
            'value', coalesce((select sum(r2.items_total_cents + r2.non_vat_cents)
                                 from public.refunds r2
                                where r2.org_id = s.org_id and r2.original_sale_id = s.id), 0),
            -- earlier refunds that paid cash out (each rounded on its own: up to 2c drift each)
            'cash_refunds', (select count(distinct rp2.refund_id)
                               from public.refund_payments rp2
                               join public.refunds r3 on r3.org_id = rp2.org_id and r3.id = rp2.refund_id
                              where r3.org_id = s.org_id and r3.original_sale_id = s.id
                                and rp2.method = 'cash'))
          from public.refund_payments rp
          join public.refunds rf on rf.org_id = rp.org_id and rf.id = rp.refund_id
          where rf.org_id = s.org_id and rf.original_sale_id = s.id)
    ) order by s.completed_at desc)
    from public.sales s
    where s.org_id = d.org_id and s.id = any (v_ids)
      and (v_role <> 'cashier' or s.register_id = d.register_id or s.cashier_user_id = v_viewer)),
    '[]'::jsonb);
end
$$;
revoke all on function ops.device_find_sale(text, jsonb) from public, anon, authenticated;
grant execute on function ops.device_find_sale(text, jsonb) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.device_refunds_known
-- Which of these refund ids are already recorded for this till's shop (a replay answers
-- `duplicate` before its quantities are re-checked, which would now look used up).
create function ops.device_refunds_known(p_token_hash text, p_ids uuid[]) returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select r.id from public.refunds r
  join app.device_register(p_token_hash) d on d.org_id = r.org_id
  where r.id = any (p_ids)
$$;
revoke all on function ops.device_refunds_known(text, uuid[]) from public, anon, authenticated;
grant execute on function ops.device_refunds_known(text, uuid[]) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.record_refund
-- One transaction. Returns 'created', 'duplicate' (same id replayed), 'receipt_clash' (the till's
-- refund number is taken) or 'original_missing' (the sale has not reached the server yet: retry).
-- Every other failure raises: 22023 = the record is wrong (a rejection, never a retry), 42501 =
-- not allowed / approval missing.
--
-- The line amounts are recomputed here: after k units refunded in total a line has returned
-- round(total * k / qty), a refund is the difference to what earlier refunds returned (the same
-- cumulative rule as refundLine in src/lib/money/refund.ts), and the rate is the original line's.
create function ops.record_refund(p jsonb, p_token_hash text) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  r jsonb := p -> 'refund';
  v_lines jsonb := p -> 'lines';
  v_pays jsonb := coalesce(p -> 'payments', '[]'::jsonb);
  v_org uuid := (r ->> 'org_id')::uuid;
  v_id uuid := (r ->> 'id')::uuid;
  v_reg uuid := (r ->> 'register_id')::uuid;
  v_user uuid := (r ->> 'user_id')::uuid;
  v_sale_id uuid := (r ->> 'original_sale_id')::uuid;
  v_kind text := r ->> 'kind';
  v_completed timestamptz := (r ->> 'completed_at')::timestamptz;
  v_items int := (r ->> 'items_total')::int;
  v_vat int := (r ->> 'vat')::int;
  v_non_vat int := (r ->> 'non_vat')::int;
  v_credit int := coalesce((r ->> 'credit')::int, 0);
  v_rounding int := (r ->> 'cash_rounding')::int;
  v_amount int := (r ->> 'amount')::int;
  v_approval uuid := nullif(r ->> 'approval_id', '')::uuid;
  v_claimed uuid := nullif(r ->> 'claimed_approver', '')::uuid;
  v_approver uuid;
  v_state text := 'not_needed';
  v_prev bigint;
  v_cash_refunds int;
  v_orig_tip bigint;
  v_role text;
  v_need boolean;
  v_loc uuid;
  v_tz text;
  v_sale public.sales%rowtype;
  v_existing public.refunds%rowtype;
  v_inserted int;
  v_matched int;
  v_bad_lines int;
  v_sum_items bigint;
  v_sum_vat bigint;
  v_sum_dep bigint;
  v_all_whole boolean;
  v_cash_n int;
  v_exch_n int;
  v_legs_sum bigint;
  v_bad_pays int;
  v_bad_cash int;
  v_tips bigint;
  v_paid record;
  v_back record;
begin
  -- Refunds come only from a paired till; the token fixes the org and register.
  if p_token_hash is null or not exists (
       select 1 from app.device_register(p_token_hash) d
        where d.org_id = v_org and d.register_id = v_reg) then
    raise exception 'not this till' using errcode = '42501';
  end if;
  if not app.is_member(v_user, v_org) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select r2.location_id into v_loc from public.registers r2 where r2.id = v_reg and r2.org_id = v_org;
  if v_loc is null then
    raise exception 'unknown register' using errcode = '42501';
  end if;

  -- A replay of a refund already recorded answers before anything is re-checked (its quantities
  -- would now look used up).
  select * into v_existing from public.refunds where id = v_id;
  if found then
    if v_existing.org_id = v_org and v_existing.register_id = v_reg then
      return 'duplicate';
    end if;
    raise exception 'refund id in use' using errcode = '23505';
  end if;

  if num_nulls(v_id, v_sale_id, v_kind, v_completed, v_items, v_vat, v_non_vat, v_rounding, v_amount,
               r ->> 'reason_code', r ->> 'receipt_seq', r ->> 'client_amount') > 0
     or v_kind not in ('refund', 'void', 'exchange') then
    raise exception 'bad refund' using errcode = '22023';
  end if;
  if (v_kind = 'exchange') <> (nullif(r ->> 'exchange_sale_id', '') is not null)
     or (v_kind = 'exchange' and v_credit <= 0)
     or (v_kind <> 'exchange' and v_credit <> 0)
     or v_credit > v_items + v_non_vat then
    raise exception 'bad exchange credit' using errcode = '22023';
  end if;
  if jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) not between 1 and 100
     or jsonb_typeof(v_pays) <> 'array' or jsonb_array_length(v_pays) > 11
     or (select count(distinct x ->> 'line_no') from jsonb_array_elements(v_lines) x)
        <> jsonb_array_length(v_lines) then
    raise exception 'bad refund' using errcode = '22023';
  end if;

  -- Lock the original sale: two tills refunding the same lines at once are serialised here.
  select * into v_sale from public.sales where id = v_sale_id and org_id = v_org for update;
  if not found then
    return 'original_missing';
  end if;
  -- The same refund arriving twice at once: the second one waited for the lock above, and the
  -- quantities the first used would now make it look wrong. It is a replay.
  if exists (select 1 from public.refunds where id = v_id and org_id = v_org and register_id = v_reg) then
    return 'duplicate';
  end if;
  -- A refund cannot pre-date its sale (10 minutes of clock difference between tills allowed).
  if v_completed < v_sale.completed_at - interval '10 minutes' then
    raise exception 'refund is before its sale' using errcode = '22023';
  end if;

  -- The lines, recomputed from the stored snapshot.
  with req as (
    select (x ->> 'line_no')::int as line_no, (x ->> 'qty')::int as qty,
           (x ->> 'gross_cents')::bigint as g, (x ->> 'vat_cents')::bigint as v,
           (x ->> 'net_cents')::bigint as n
      from jsonb_array_elements(v_lines) x),
  calc as (
    select req.*, sl.id as line_id, sl.kind, sl.qty as sold_qty, sl.gross_cents as sg, sl.vat_cents as sv,
           coalesce((select sum(rl.qty) from public.refund_lines rl
                      where rl.org_id = v_org and rl.sale_line_id = sl.id), 0) as done
      from req
      join public.sale_lines sl on sl.line_no = req.line_no and sl.org_id = v_org and sl.sale_id = v_sale_id)
  select count(*),
         count(*) filter (where qty < 1 or qty + done > sold_qty
           or g is null
           or g <> round(sg::numeric * (done + qty) / sold_qty) - round(sg::numeric * done / sold_qty)
           or (kind = 'item' and (v is null or n is null
               or v <> round(sv::numeric * (done + qty) / sold_qty) - round(sv::numeric * done / sold_qty)
               or n <> g - v))),
         coalesce(sum(g) filter (where kind = 'item'), 0),
         coalesce(sum(v) filter (where kind = 'item'), 0),
         coalesce(sum(g) filter (where kind = 'deposit'), 0),
         coalesce(bool_and(qty = sold_qty and done = 0), false)
    into v_matched, v_bad_lines, v_sum_items, v_sum_vat, v_sum_dep, v_all_whole
    from calc;
  if v_matched <> jsonb_array_length(v_lines) then
    raise exception 'lines are not on this sale' using errcode = '22023';
  end if;
  if v_bad_lines > 0 or v_sum_items <> v_items or v_sum_vat <> v_vat or v_sum_dep <> v_non_vat then
    raise exception 'refund does not add up' using errcode = '22023';
  end if;

  -- A void reverses the whole sale: every line in full, nothing refunded before, the same till
  -- and the same shop-local day.
  if v_kind = 'void' then
    select l.timezone into v_tz from public.locations l where l.id = v_loc and l.org_id = v_org;
    if not v_all_whole
       or v_sale.completed_at < now() - interval '48 hours'
       or (select count(*) from public.sale_lines sl where sl.org_id = v_org and sl.sale_id = v_sale_id)
          <> jsonb_array_length(v_lines)
       or v_sale.register_id <> v_reg
       or (v_sale.completed_at at time zone coalesce(v_tz, 'Europe/Dublin'))::date
          <> (v_completed at time zone coalesce(v_tz, 'Europe/Dublin'))::date then
      raise exception 'not a voidable sale' using errcode = '22023';
    end if;
  end if;

  -- The legs. Card and voucher are exact; cash is the cash share plus rounding (a multiple of 5
  -- when rounded); the exchange leg is the credit. Tips go back only on a void.
  if exists (select 1 from jsonb_array_elements(v_pays) x
              where jsonb_typeof(x) <> 'object'
                 or coalesce(x ->> 'method', '') not in ('cash', 'card', 'voucher', 'exchange')
                 or (x ->> 'amount') is null
                 or (x ->> 'amount')::bigint <= 0
                 or coalesce((x ->> 'tip')::bigint, 0) < 0
                 or (coalesce((x ->> 'tip')::bigint, 0) > 0
                     and (x ->> 'method' <> 'card' or v_kind <> 'void'
                          or (x ->> 'tip')::bigint > (x ->> 'amount')::bigint))) then
    raise exception 'payments are not valid' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_pays) x
             where nullif(x ->> 'type_id', '') is not null
               and not exists (select 1 from public.tender_types tt
                               where tt.id = (x ->> 'type_id')::uuid and tt.org_id = v_org
                                 and tt.location_id = v_loc and tt.method = x ->> 'method')) then
    raise exception 'unknown payment type' using errcode = '22023';
  end if;
  select count(*) filter (where x ->> 'method' = 'cash'),
         count(*) filter (where x ->> 'method' = 'exchange'),
         coalesce(sum((x ->> 'amount')::bigint) filter (where x ->> 'method' <> 'exchange'), 0),
         count(*) filter (where x ->> 'method' = 'cash' and v_rounding <> 0
                            and mod((x ->> 'amount')::bigint, 5) <> 0),
         coalesce(sum((x ->> 'tip')::bigint), 0)
    into v_cash_n, v_exch_n, v_legs_sum, v_bad_cash, v_tips
    from jsonb_array_elements(v_pays) x;
  select count(*) into v_bad_pays from jsonb_array_elements(v_pays) x
   where x ->> 'method' = 'exchange'
     and ((x ->> 'amount')::bigint <> v_credit or nullif(x ->> 'type_id', '') is not null);
  -- Rounding belongs to the cash leg alone; and a void returns at most the tip the sale took.
  select coalesce(sum(p.tip_cents), 0) into v_orig_tip
    from public.payments p where p.org_id = v_org and p.sale_id = v_sale_id;
  if (v_cash_n = 0 and v_rounding <> 0) or v_tips > v_orig_tip then
    raise exception 'refund payments do not add up' using errcode = '22023';
  end if;
  if v_cash_n > 1 or v_exch_n > 1 or v_bad_pays > 0 or v_bad_cash > 0
     or (v_kind = 'exchange') <> (v_exch_n = 1)
     or v_rounding not between -2 and 2
     or v_amount <> v_items + v_non_vat - v_credit + v_rounding
     or v_legs_sum <> v_amount
     or v_amount < 0 then
    raise exception 'refund payments do not add up' using errcode = '22023';
  end if;

  -- Each method pays back no more than it took. A card sale can never be refunded in cash, and
  -- exchange credit that paid for the sale goes back as a voucher (never cash: it may stand for a
  -- card payment on an earlier sale). Cash may stray 2c per refund, for 5c rounding.
  select coalesce(sum(p.amount_cents) filter (where p.method = 'cash'), 0) as cash,
         coalesce(sum(p.amount_cents) filter (where p.method = 'card'), 0) as card,
         coalesce(sum(p.amount_cents) filter (where p.method in ('voucher', 'exchange')), 0) as voucher
    into v_paid from public.payments p where p.org_id = v_org and p.sale_id = v_sale_id;
  select coalesce(sum(rp.amount_cents) filter (where rp.method = 'cash'), 0) as cash,
         coalesce(sum(rp.amount_cents) filter (where rp.method = 'card'), 0) as card,
         coalesce(sum(rp.amount_cents) filter (where rp.method = 'voucher'), 0) as voucher
    into v_back from public.refund_payments rp
    join public.refunds rf on rf.org_id = rp.org_id and rf.id = rp.refund_id
   where rf.org_id = v_org and rf.original_sale_id = v_sale_id;
  select count(distinct rp.refund_id) into v_cash_refunds
    from public.refund_payments rp
    join public.refunds rf on rf.org_id = rp.org_id and rf.id = rp.refund_id
   where rf.org_id = v_org and rf.original_sale_id = v_sale_id and rp.method = 'cash';
  if exists (select 1 from jsonb_array_elements(v_pays) x
             where (x ->> 'method' = 'cash'
                    and (x ->> 'amount')::bigint > v_paid.cash - v_back.cash + case when v_paid.cash > 0 then 2 * (1 + v_cash_refunds) else 0 end)
                or (x ->> 'method' = 'card' and (x ->> 'amount')::bigint > v_paid.card - v_back.card)
                or (x ->> 'method' = 'voucher' and (x ->> 'amount')::bigint > v_paid.voucher - v_back.voucher)) then
    raise exception 'refund exceeds what was paid by that method' using errcode = '22023';
  end if;

  -- Who approved. A cashier's refund above the shop's limit, and every void, needs a manager.
  -- Only a single-use 'refund' approval the server issued for a PIN it checked is proof
  -- ('verified'). The cash has already left the till by the time a refund syncs, so a refund that
  -- cannot show that proof is still recorded, but its state says so and the owner sees it:
  --   'unverified' = the till names the manager whose cached PIN it checked while offline;
  --   'self'       = the till says a manager or owner was serving (the till's word, as for sales).
  -- A cashier who shows neither is refused (42501) and the refund waits in Needs attention.
  select m.role into v_role from public.memberships m where m.org_id = v_org and m.user_id = v_user;
  -- "Needs a manager" is decided from the refund alone, never from who the till says is serving.
  -- Cumulative: refunding a big sale a little at a time does not get round the limit.
  select coalesce(sum(r2.items_total_cents + r2.non_vat_cents), 0) into v_prev
    from public.refunds r2 where r2.org_id = v_org and r2.original_sale_id = v_sale_id;
  v_need := v_kind = 'void'
    or v_prev + v_items + v_non_vat > (select o.refund_override_cents
                                         from public.organisations o where o.id = v_org);
  if v_approval is not null then
    select a.approver_user_id into v_approver
      from public.register_approvals a
     where a.id = v_approval and a.org_id = v_org and a.register_id = v_reg
       and a.purpose = 'refund' and a.consumed_at is null
       -- bound to one sale and a value: not any refund in the shop
       and a.sale_id = v_sale_id and a.max_cents >= v_items + v_non_vat
       and v_completed between a.created_at - interval '1 minute' and a.created_at + interval '30 minutes'
       -- the till's clock is not trusted for how old an approval may be: at most a day on ours
       and now() <= a.created_at + interval '24 hours'
     for update;
    if v_approver is null then
      raise exception 'approval not valid' using errcode = '42501';
    end if;
    v_state := 'verified';
  elsif v_claimed is not null and v_need then
    if not app.is_manager(v_claimed, v_org) then
      raise exception 'approver is not a manager' using errcode = '42501';
    end if;
    v_approver := v_claimed;
    v_state := 'unverified';
  end if;
  if v_need and v_approver is null then
    if v_role not in ('owner', 'manager') then
      raise exception 'manager approval needed' using errcode = '42501';
    end if;
    v_state := 'self';
  end if;
  if v_approver is not null and not app.is_manager(v_approver, v_org) then
    raise exception 'approver is not a manager' using errcode = '42501';
  end if;

  begin
    insert into public.refunds (id, org_id, register_id, location_id, original_sale_id, kind, reason_code,
                                reason_note, receipt_seq, completed_at, cashier_user_id, approved_by,
                                approval_id, approval_state, items_total_cents, vat_cents, non_vat_cents,
                                credit_cents, cash_rounding_cents, amount_cents, client_amount_cents,
                                exchange_sale_id)
    values (v_id, v_org, v_reg, v_loc, v_sale_id, v_kind, r ->> 'reason_code',
            nullif(r ->> 'reason_note', ''), (r ->> 'receipt_seq')::int, v_completed, v_user, v_approver,
            v_approval, v_state, v_items, v_vat, v_non_vat, v_credit, v_rounding, v_amount,
            (r ->> 'client_amount')::int, nullif(r ->> 'exchange_sale_id', '')::uuid);
    get diagnostics v_inserted = row_count;
  exception when unique_violation then
    return 'receipt_clash';
  end;

  if v_approval is not null then
    update public.register_approvals set consumed_at = now(), consumed_for = v_id where id = v_approval;
  end if;
  -- Recorded (the money has left the till) but not proven: a manager must look at it and close it.
  if v_state in ('unverified', 'self') then
    insert into public.sync_rejections (id, org_id, register_id, reason, detail, payload)
    values (v_id, v_org, v_reg, 'refund_unverified',
            jsonb_build_object('kind', 'refund', 'recorded', true, 'state', v_state,
                               'refund_kind', v_kind, 'amount_cents', v_amount),
            jsonb_build_object('refund_id', v_id, 'original_sale_id', v_sale_id));
  end if;

  insert into public.refund_lines (id, org_id, refund_id, sale_line_id, line_no, kind, variant_id, name, qty,
                                   serial, restock, tax_category, tax_rate_bp, net_cents, vat_cents, gross_cents)
  select gen_random_uuid(), v_org, v_id, sl.id, q.ord::int, sl.kind, sl.variant_id, sl.name,
         (q.value ->> 'qty')::int, sl.serial, coalesce((q.value ->> 'restock')::boolean, true),
         sl.tax_category, sl.tax_rate_bp, (q.value ->> 'net_cents')::int,
         case when sl.kind = 'item' then (q.value ->> 'vat_cents')::int end, (q.value ->> 'gross_cents')::int
  from jsonb_array_elements(v_lines) with ordinality as q(value, ord)
  join public.sale_lines sl on sl.line_no = (q.value ->> 'line_no')::int and sl.sale_id = v_sale_id
    and sl.org_id = v_org;

  insert into public.refund_payments (id, org_id, refund_id, tender_type_id, label, method, amount_cents,
                                      tip_cents, provider_ref)
  select gen_random_uuid(), v_org, v_id, nullif(x ->> 'type_id', '')::uuid,
         coalesce((select tt.label from public.tender_types tt
                    where tt.org_id = v_org and tt.id = nullif(x ->> 'type_id', '')::uuid),
                  case when x ->> 'method' = 'exchange' then 'Exchange credit' else initcap(x ->> 'method') end),
         x ->> 'method', (x ->> 'amount')::int, coalesce((x ->> 'tip')::int, 0),
         nullif(x ->> 'reference', '')
  from jsonb_array_elements(v_pays) x;

  -- Put the units back (only where the cashier said so and the item is stock-tracked).
  insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, ref_id, actor_user_id)
  select gen_random_uuid(), v_org, rl.variant_id, v_loc, sum(rl.qty)::int, 'refund', v_id, v_user
  from public.refund_lines rl
  join public.sale_lines sl on sl.org_id = rl.org_id and sl.id = rl.sale_line_id
  join public.products p on p.org_id = sl.org_id and p.id = sl.product_id
  where rl.refund_id = v_id and rl.kind = 'item' and rl.restock and rl.variant_id is not null and p.track_stock
  group by rl.variant_id;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (gen_random_uuid(), v_org, v_user,
          case when v_kind = 'void' then 'sale.voided' else 'refund.created' end, 'refund', v_id,
          jsonb_build_object('kind', v_kind, 'original_sale_id', v_sale_id, 'register_id', v_reg,
                             'reason', r ->> 'reason_code', 'amount_cents', v_amount,
                             'credit_cents', v_credit, 'approved_by', v_approver,
                             'approval', v_state));

  update public.registers set last_seen_at = now() where id = v_reg and org_id = v_org;
  return 'created';
end
$$;
revoke all on function ops.record_refund(jsonb, text) from public, anon, authenticated;
grant execute on function ops.record_refund(jsonb, text) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.record_sale (replaced)
-- Built on 0028's version and changed only for exchange credit: a payment with method 'exchange'
-- carries the refund that paid for it (p -> 'payments' -> 'refund_id'). That refund must be an
-- exchange refund of this org naming this sale, for exactly this amount (22023 otherwise); if it
-- has not reached the server yet the sale answers 'exchange_pending' and is retried, so the credit
-- is never taken on trust. Each credit can pay for one sale only (unique index).

create or replace function ops.record_sale(p jsonb, p_token_hash text default null) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  s jsonb := p -> 'sale';
  -- 1-10 payments; the old single p -> 'payment' still works for sales queued before tender types.
  v_pays jsonb := coalesce(p -> 'payments', jsonb_build_array(p -> 'payment'));
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
  v_flags text[] := coalesce(array(select jsonb_array_elements_text(coalesce(s -> 'review_flags', '[]'::jsonb))), '{}');
  v_loc uuid;
  v_inserted int;
  v_existing public.sales%rowtype;
  v_sum_gross bigint;
  v_sum_vat bigint;
  v_sum_deposit bigint;
  v_bad_lines int;
  v_cash_n int;
  v_pay_sum bigint;
  v_bad_pays int;
  v_bad_cash int;
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
  -- The payments, shaped before they are summed. Cash settles its share plus rounding (what was
  -- handed over less the change); card and voucher settle exactly their amount, with no change.
  if jsonb_typeof(v_pays) <> 'array' or jsonb_array_length(v_pays) not between 1 and 10
     or exists (select 1 from jsonb_array_elements(v_pays) x
                where jsonb_typeof(x) <> 'object'
                   or coalesce(x ->> 'method', '') not in ('cash', 'card', 'voucher', 'exchange')
                   or num_nulls(x ->> 'amount', x ->> 'tendered') > 0) then
    raise exception 'payments are not valid' using errcode = '22023';
  end if;
  select count(*) filter (where x ->> 'method' = 'cash'),
         coalesce(sum((x ->> 'amount')::bigint), 0),
         count(*) filter (where (x ->> 'amount')::bigint < 0
                            or coalesce((x ->> 'change')::bigint, 0) < 0
                            or (x ->> 'tendered')::bigint - coalesce((x ->> 'change')::bigint, 0)
                               is distinct from (x ->> 'amount')::bigint
                            or (x ->> 'method' <> 'cash' and coalesce((x ->> 'change')::bigint, 0) <> 0)),
         -- When the cash share was rounded, the cash taken for it ends in 0 or 5.
         count(*) filter (where x ->> 'method' = 'cash' and v_rounding <> 0
                            and mod((x ->> 'amount')::bigint, 5) <> 0)
    into v_cash_n, v_pay_sum, v_bad_pays, v_bad_cash
    from jsonb_array_elements(v_pays) x;
  if exists (select 1 from jsonb_array_elements(v_pays) x
             where nullif(x ->> 'type_id', '') is not null
               and not exists (select 1 from public.tender_types tt
                               where tt.id = (x ->> 'type_id')::uuid and tt.org_id = v_org
                                 and tt.location_id = v_loc and tt.method = x ->> 'method')) then
    raise exception 'unknown payment type' using errcode = '22023';
  end if;

  -- Exchange credit: at most one, no change/tip/type, and backed by this sale's exchange refund.
  if (select count(*) from jsonb_array_elements(v_pays) x where x ->> 'method' = 'exchange') > 1
     or exists (select 1 from jsonb_array_elements(v_pays) x
                 where x ->> 'method' = 'exchange'
                   and (nullif(x ->> 'refund_id', '') is null
                        or coalesce((x ->> 'change')::bigint, 0) <> 0
                        or coalesce((x ->> 'tip')::bigint, 0) <> 0
                        or nullif(x ->> 'type_id', '') is not null)) then
    raise exception 'exchange credit is not valid' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v_pays) x
              where x ->> 'method' = 'exchange'
                and not exists (select 1 from public.refunds rf
                                 where rf.org_id = v_org and rf.id = (x ->> 'refund_id')::uuid)) then
    return 'exchange_pending';
  end if;
  if exists (select 1 from jsonb_array_elements(v_pays) x
              where x ->> 'method' = 'exchange'
                and not exists (select 1 from public.refunds rf
                                 where rf.org_id = v_org and rf.id = (x ->> 'refund_id')::uuid
                                   and rf.kind = 'exchange' and rf.exchange_sale_id = v_id
                                   and rf.credit_cents = (x ->> 'amount')::bigint)) then
    raise exception 'exchange credit does not match its refund' using errcode = '22023';
  end if;

  if num_nulls(v_items_total, v_vat, v_non_vat, v_rounding, v_due) > 0
     or v_bad_lines > 0
     or v_sum_gross <> v_items_total or v_sum_vat <> v_vat or v_sum_deposit <> v_non_vat
     or v_due <> v_items_total + v_non_vat + v_rounding
     -- 5c cash rounding moves the cash share by at most 2c (and only where the shop rounds).
     or v_rounding not between -2 and 2
     or v_pay_sum <> v_due or v_cash_n > 1 or v_bad_pays > 0 or v_bad_cash > 0 then
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

  insert into public.payments (id, org_id, sale_id, tender_type_id, label, method, amount_cents,
                               tendered_cents, change_cents, tip_cents, provider_ref, exchange_refund_id)
  select gen_random_uuid(), v_org, v_id, nullif(x ->> 'type_id', '')::uuid,
         coalesce((select tt.label from public.tender_types tt
                   where tt.org_id = v_org and tt.id = nullif(x ->> 'type_id', '')::uuid),
                  initcap(x ->> 'method')),
         x ->> 'method', (x ->> 'amount')::int, (x ->> 'tendered')::int,
         coalesce((x ->> 'change')::int, 0), coalesce((x ->> 'tip')::int, 0),
         nullif(x ->> 'reference', ''), nullif(x ->> 'refund_id', '')::uuid
  from jsonb_array_elements(v_pays) x;

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
