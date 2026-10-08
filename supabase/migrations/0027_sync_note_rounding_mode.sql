-- A sale is priced with the rounding mode it was rung up with (syncSale.roundCash), which can differ
-- from the shop's setting at sync time if the business type changed while the till was offline. The
-- sale is accepted and left exactly as it was; this records the difference in the append-only audit
-- log so a manager can see it. Called by the sync route after ops.record_sale returned 'created'.
create function ops.record_sync_note(p jsonb) returns void
language plpgsql volatile security definer set search_path = ''
as $$
declare
  v_org uuid := (p ->> 'org_id')::uuid;
  v_sale uuid := (p ->> 'sale_id')::uuid;
  v_user uuid := (p ->> 'user_id')::uuid;
begin
  if p ->> 'kind' is distinct from 'rounding_mode_differs' then
    raise exception 'unknown note' using errcode = '22023';
  end if;
  -- The sale must exist in that shop; the org never comes from anything but the sale's own row.
  if not exists (select 1 from public.sales s where s.id = v_sale and s.org_id = v_org) then
    raise exception 'unknown sale' using errcode = '22023';
  end if;
  -- The actor is recorded as given, so it must really be staff of that shop.
  if not app.is_member(v_user, v_org) then
    raise exception 'not a member' using errcode = '42501';
  end if;
  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (gen_random_uuid(), v_org, v_user, 'sale.rounding_mode_differs', 'sale', v_sale,
          jsonb_build_object('sale_round_cash', (p ->> 'sale_round_cash')::boolean,
                             'shop_round_cash', (p ->> 'shop_round_cash')::boolean));
end
$$;

revoke all on function ops.record_sync_note(jsonb) from public, anon, authenticated;
grant execute on function ops.record_sync_note(jsonb) to service_role, tillflow_ops;
