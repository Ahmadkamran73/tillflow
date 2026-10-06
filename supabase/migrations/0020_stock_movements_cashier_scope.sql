-- Hand-written: a cashier reads only the sales they rang up (0019), so the stock ledger must not
-- show them other cashiers' sales either (each 'sale'/'refund' row names the variant, quantity,
-- time and cashier). Managers and owners read the whole ledger; a cashier reads opening stock and
-- adjustments (shop-wide facts) plus their own rows. stock_levels, the running total, stays open to
-- every member.
drop policy stock_movements_select on public.stock_movements;
create policy stock_movements_select on public.stock_movements for select to authenticated
  using (
    org_id in (select app.manager_org_ids())
    or (
      org_id in (select app.current_org_ids())
      and (reason in ('opening', 'adjustment') or actor_user_id = (select app.current_user_id()))
    )
  );
