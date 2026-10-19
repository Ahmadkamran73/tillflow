-- Hand-written: inventory (Phase 2 step 2.4). Columns and the widened reason check are in 0034.
-- Managers and owners may record damage, count and received movements (as themselves, with a note);
-- low_stock_threshold is a manager-writable product column (set from the Inventory page, not save_product); adjust_stock turns a user's input into
-- one ledger row (the stock_levels trigger from 0013 updates the cached total in the same statement).

-- ---------------------------------------------------------------- grants and policy
grant insert (note) on public.stock_movements to authenticated;
grant update (low_stock_threshold) on public.products to authenticated;

drop policy stock_movements_insert on public.stock_movements;
create policy stock_movements_insert on public.stock_movements for insert to authenticated
  with check (
    org_id in (select app.manager_org_ids())
    and reason in ('opening', 'adjustment', 'damage', 'count', 'received')
    and actor_user_id = (select app.current_user_id())
  );

-- ---------------------------------------------------------------- adjust_stock
-- SECURITY INVOKER: RLS applies, so a cashier or another shop's user fails on the insert.
-- p_qty means: received = units in (> 0); damage = units lost (> 0, stored negative);
-- adjustment = signed, not 0; count = what was counted on the shelf (>= 0), the ledger gets
-- counted - on_hand. Returns the movement's qty_delta. A count equal to on_hand raises 22023.
-- Counts of the same variant are serialised; a sale landing between the read and the insert is
-- still correct (the trigger adds the delta to the live total), the count is then off by that sale.
create function public.adjust_stock(
  p_org uuid, p_variant uuid, p_location uuid, p_reason text, p_qty int, p_note text
)
returns int
language plpgsql security invoker set search_path = ''
as $$
declare
  v_delta int;
  v_on_hand int;
  v_note text := nullif(btrim(p_note), '');
begin
  if p_reason not in ('adjustment', 'damage', 'count', 'received') then
    raise exception 'unknown reason' using errcode = '22023';
  end if;
  if p_qty is null or p_qty not between -1000000 and 1000000 then
    raise exception 'quantity out of range' using errcode = '22023';
  end if;
  if v_note is not null and char_length(v_note) > 200 then
    raise exception 'note too long' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.variants v join public.products p on p.org_id = v.org_id and p.id = v.product_id
     where v.org_id = p_org and v.id = p_variant and v.archived_at is null and p.track_stock
  ) then
    raise exception 'variant not found or not stock-tracked' using errcode = '22023';
  end if;

  if p_reason = 'count' then
    if p_qty < 0 then
      raise exception 'a count cannot be negative' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_variant::text || p_location::text, 0));
    select coalesce(
      (select on_hand from public.stock_levels
        where org_id = p_org and variant_id = p_variant and location_id = p_location), 0)
      into v_on_hand;
    v_delta := p_qty - v_on_hand;
  elsif p_reason = 'damage' then
    if p_qty <= 0 then
      raise exception 'damaged units must be more than 0' using errcode = '22023';
    end if;
    v_delta := -p_qty;
  elsif p_reason = 'received' then
    if p_qty <= 0 then
      raise exception 'received units must be more than 0' using errcode = '22023';
    end if;
    v_delta := p_qty;
  else
    v_delta := p_qty;
  end if;

  if v_delta = 0 then
    raise exception 'nothing to record' using errcode = '22023';
  end if;

  insert into public.stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, note, actor_user_id)
  values (gen_random_uuid(), p_org, p_variant, p_location, v_delta, p_reason, v_note,
          (select app.current_user_id()));
  return v_delta;
end
$$;

revoke all on function public.adjust_stock(uuid, uuid, uuid, text, int, text) from public, anon;
grant execute on function public.adjust_stock(uuid, uuid, uuid, text, int, text) to authenticated;
