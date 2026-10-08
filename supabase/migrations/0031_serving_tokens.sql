-- Hand-written: server-signed "serving as" tokens (Phase 2 step 2.2, security follow-up).
--
-- When a PIN is checked at unlock the server issues a short-lived token naming WHO is serving, on
-- WHICH till of WHICH shop. record_refund and the sale lookup verify it themselves, so the person
-- serving is no longer whatever the till says. A manager's refund approval stays a single-use
-- register_approvals row bound to one sale and a value. Without a valid token (a till that was
-- offline when the PIN was typed, an expired or altered token) nothing is proven and the existing
-- "Not verified" + Needs attention path applies.
--
-- The signing key lives in this database only (generated here, per environment); the app never
-- sees it. HMAC-SHA256 from pgcrypto, which Supabase keeps in the extensions schema.

create table ops.signing_keys (
  id integer primary key check (id = 1),
  key bytea not null default extensions.gen_random_bytes(32),
  created_at timestamptz not null default now()
);
insert into ops.signing_keys (id) values (1);
alter table ops.signing_keys enable row level security;
revoke all on ops.signing_keys from public, anon, authenticated, service_role, tillflow_ops;
-- The key is never changed or removed (rotating it would simply end every token; do that on purpose).
create trigger signing_keys_fixed before update or delete on ops.signing_keys
  for each row execute function app.forbid_change();
create trigger signing_keys_no_truncate before truncate on ops.signing_keys
  for each statement execute function app.forbid_change();

-- ---------------------------------------------------------------- ops.issue_serving_token
-- Called by the unlock route AFTER it verified the PIN. One hour; bound to this till and shop.
create function ops.issue_serving_token(p_token_hash text, p_user uuid) returns text
language plpgsql volatile security definer set search_path = ''
as $$
declare
  d record;
  v_key bytea;
  v_iat bigint := extract(epoch from now())::bigint;
  v_payload text;
  v_paired bigint;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    raise exception 'unknown device' using errcode = '42501';
  end if;
  -- tied to this pairing: pairing the till again ends every token it had
  select coalesce(extract(epoch from r.paired_at)::bigint, 0) into v_paired
    from public.registers r where r.id = d.register_id and r.org_id = d.org_id;
  if not app.is_member(p_user, d.org_id) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  select k.key into v_key from ops.signing_keys k where k.id = 1;
  v_payload := replace(encode(convert_to(jsonb_build_object(
      'v', 1, 'u', p_user, 'o', d.org_id, 'r', d.register_id, 'p', v_paired,
      'iat', v_iat, 'exp', v_iat + 3600, 'jti', gen_random_uuid())::text, 'utf8'), 'base64'), E'\n', '');
  return v_payload || '.' || encode(extensions.hmac(convert_to(v_payload, 'utf8'), v_key, 'sha256'), 'hex');
end
$$;
revoke all on function ops.issue_serving_token(text, uuid) from public, anon, authenticated;
grant execute on function ops.issue_serving_token(text, uuid) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.verify_serving_token
-- No row = proves nothing. A row = the server signed it, it is for THIS shop and THIS till, it was
-- valid at p_at (the moment of the action: a refund made offline is checked at the time it was
-- made), the person is still staff here, and it is not older than p_grace past its expiry on the
-- server's own clock (so a token cannot be replayed indefinitely).
create function ops.verify_serving_token(
  p_token text, p_org uuid, p_register uuid, p_at timestamptz, p_grace interval
) returns table (user_id uuid)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_key bytea;
  v_payload text;
  v_sig text;
  v_expected text;
  v_json jsonb;
  v_paired bigint;
begin
  if p_token is null or p_at is null or p_token !~ '^[A-Za-z0-9+/=]+\.[0-9a-f]{64}$'
     or length(p_token) > 500 then
    return;
  end if;
  v_payload := split_part(p_token, '.', 1);
  v_sig := split_part(p_token, '.', 2);
  select k.key into v_key from ops.signing_keys k where k.id = 1;
  if v_key is null then
    return; -- no key, no proof (never let a null comparison pass)
  end if;
  v_expected := encode(extensions.hmac(convert_to(v_payload, 'utf8'), v_key, 'sha256'), 'hex');
  -- compare the MACs of both strings, so the comparison does not leak where they differ
  if extensions.hmac(convert_to(v_expected, 'utf8'), v_key, 'sha256')
     is distinct from extensions.hmac(convert_to(v_sig, 'utf8'), v_key, 'sha256') then
    return;
  end if;
  select coalesce(extract(epoch from r.paired_at)::bigint, 0) into v_paired
    from public.registers r where r.id = p_register and r.org_id = p_org;
  begin
    v_json := convert_from(decode(v_payload, 'base64'), 'utf8')::jsonb;
    if (v_json ->> 'v') is distinct from '1'
       or (v_json ->> 'p')::bigint is distinct from v_paired
       or (v_json ->> 'o')::uuid is distinct from p_org
       or (v_json ->> 'r')::uuid is distinct from p_register
       or p_at < to_timestamp((v_json ->> 'iat')::bigint) - interval '1 minute'
       or p_at > to_timestamp((v_json ->> 'exp')::bigint)
       or now() > to_timestamp((v_json ->> 'exp')::bigint) + p_grace
       or not app.is_member((v_json ->> 'u')::uuid, p_org) then
      return;
    end if;
  exception when others then
    return;
  end;
  return query select (v_json ->> 'u')::uuid;
end
$$;
revoke all on function ops.verify_serving_token(text, uuid, uuid, timestamptz, interval) from public, anon, authenticated;
grant execute on function ops.verify_serving_token(text, uuid, uuid, timestamptz, interval) to service_role, tillflow_ops;

-- ---------------------------------------------------------------- ops.record_refund (replaced)
create or replace function ops.record_refund(p jsonb, p_token_hash text) returns text
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
  v_serving uuid;
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
  -- Who is serving: only the server's own signed "serving as" token (issued when the PIN was checked)
  -- proves it. A token for someone else than the named cashier is refused; no token, an expired or
  -- altered one, or one for another till simply proves nothing (the claim stays a claim).
  if nullif(r ->> 'serving_token', '') is not null then
    select s.user_id into v_serving
      from ops.verify_serving_token(r ->> 'serving_token', v_org, v_reg, v_completed, interval '24 hours') s;
    if v_serving is not null and v_serving <> v_user then
      raise exception 'serving token is for someone else' using errcode = '42501';
    end if;
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
    -- A manager or owner whose PIN the server checked when they unlocked (signed token) is proven.
    -- Otherwise it is only the till's word.
    v_state := case when v_serving is not null then 'verified' else 'self' end;
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
                             'approval', v_state, 'serving_verified', v_serving is not null));

  update public.registers set last_seen_at = now() where id = v_reg and org_id = v_org;
  return 'created';
end
$$;

-- ---------------------------------------------------------------- ops.device_find_sale (replaced)
-- Same as before except who is asking: from the signed token (or 'internal' for the server's own sync
-- check), not from a user id the till names.
create or replace function ops.device_find_sale(p_token_hash text, p_query jsonb) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  d record;
  v_by text := p_query ->> 'by';
  v_ids uuid[];
  v_viewer uuid;
  v_role text;
begin
  select * into d from app.device_register(p_token_hash);
  if not found then
    return null;
  end if;
  if coalesce((p_query ->> 'internal')::boolean, false) then
    -- The sync check itself (privileged, server side) reads the sale it is judging. The lookup route
    -- never sets this: it is built from validated fields only.
    v_role := 'owner';
  else
    -- Who is asking comes from the server-signed token, never from a name the till sends. With no
    -- valid token the till is treated as a cashier with sales of its own to find: this till's only.
    select s.user_id into v_viewer
      from ops.verify_serving_token(p_query ->> 'serving', d.org_id, d.register_id, now(), interval '0') s;
    select m.role into v_role from public.memberships m
     where m.org_id = d.org_id and m.user_id = v_viewer;
    v_role := coalesce(v_role, 'cashier');
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
