-- Hand-written: closes the remaining direct write paths for a paused business (found by the
-- automated review of 0055). Same rule as 0055: while paused nothing that changes how the shop
-- trades may be saved.
--   * locations and registers are written directly through the API: restrictive policies
--     (removing a till stays possible for owners, like revoke_register)
--   * undo_import rewrites the catalogue and stock, so it is refused too
-- Deliberately still allowed while paused: anonymise_customer and set_marketing_consent (a person's
-- erasure and consent-withdrawal rights must never wait on an invoice), mark_sale_reviewed (an
-- audit flag, no trading data), ops.pair_register (can only use a code made before the pause,
-- which lasts ten minutes; creating codes is blocked).

do $$
begin
  create policy locations_org_writable_ins on public.locations as restrictive for insert to authenticated
    with check (app.org_writable(org_id));
  create policy locations_org_writable_upd on public.locations as restrictive for update to authenticated
    using (app.org_writable(org_id)) with check (app.org_writable(org_id));
  create policy locations_org_writable_del on public.locations as restrictive for delete to authenticated
    using (app.org_writable(org_id));

  create policy registers_org_writable_ins on public.registers as restrictive for insert to authenticated
    with check (app.org_writable(org_id));
  create policy registers_org_writable_upd on public.registers as restrictive for update to authenticated
    using (app.org_writable(org_id)) with check (app.org_writable(org_id));
  -- Owners may still remove a till while paused (it only reduces access).
  create policy registers_org_writable_del on public.registers as restrictive for delete to authenticated
    using (app.org_writable_or_owner(org_id));
end
$$;

alter function public.undo_import(uuid, uuid) rename to undo_import_billing;
revoke all on function public.undo_import_billing(uuid, uuid) from public, anon, authenticated, service_role;
create function public.undo_import(p_org uuid, p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = ''
as $$
begin
  if not app.org_writable(p_org) then
    perform app.refuse_paused(p_org);
  end if;
  return public.undo_import_billing(p_org, p_id);
end
$$;
revoke all on function public.undo_import(uuid, uuid) from public, anon;
grant execute on function public.undo_import(uuid, uuid) to authenticated;
