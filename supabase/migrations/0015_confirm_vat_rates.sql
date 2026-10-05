-- Hand-written: an owner confirms the VAT rates the app uses for their shop (Settings > VAT rates).
-- Records who and when on the organisation and writes an audit row holding the rates in force that
-- day. Owner only (app.owner_org_ids needs aal2). Re-confirming is allowed and logged again.
create function public.confirm_vat_rates(p_org_id uuid, p_audit_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_user uuid := (select app.current_user_id());
  v_country text;
  v_rates jsonb;
begin
  if v_user is null or p_org_id is null or p_audit_id is null
     or not exists (select 1 from app.owner_org_ids() o where o = p_org_id) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select country into v_country from public.organisations where id = p_org_id for update;

  select coalesce(jsonb_agg(jsonb_build_object('code', code, 'rate_bp', rate_bp) order by code), '[]'::jsonb)
    into v_rates
    from public.tax_rates
   where country = v_country
     and valid_from <= (now() at time zone 'Europe/Dublin')::date
     and (valid_to is null or valid_to >= (now() at time zone 'Europe/Dublin')::date);

  update public.organisations
     set vat_rates_confirmed_at = now(), vat_rates_confirmed_by = v_user
   where id = p_org_id;

  insert into public.audit_log (id, org_id, actor_user_id, action, entity, entity_id, after)
  values (p_audit_id, p_org_id, v_user, 'organisation.vat_rates_confirmed', 'organisation', p_org_id,
          jsonb_build_object('country', v_country, 'rates', v_rates));
end
$$;

revoke all on function public.confirm_vat_rates(uuid, uuid) from public, anon;
grant execute on function public.confirm_vat_rates(uuid, uuid) to authenticated;
