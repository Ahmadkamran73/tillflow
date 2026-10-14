# Reports and exports

Phase 2 · Step 2.9 (last step of Phase 2). PLAN.md sections 3 (Reports), 5 (Export) and 11 (pre-aggregation).

## Summary

Managers and owners get a dashboard ("today against the same weekday last week", best sellers, the tiles
their business type asks for) and a Reports area (sales by day / product / category / staff / hour, VAT by
rate and period for the VAT3, payments by type, tips, covers and spend per cover, serials sold, brand,
size and colour). Every report downloads as CSV, Excel or PDF exactly as filtered on screen. Owners can
also download everything the shop holds as one ZIP (GDPR portability).

## Out of scope

Margin and COGS, Xero/Sage export, scheduled report emails, multi-location pickers (one location),
a VAT3 filing format (the report is the working figures, the accountant confirms the layout), per-hour
tips, customer reports, an interactive chart.

## Decisions (defaults, 2026-10-14)

- **Basis.** Every figure is a SUM of cents already stored on the sale lines, payments and refunds. No
  maths in the report path, so `src/lib/money` is unchanged (spend per cover uses `roundHalfUp`).
- **Refunds** are dated by the refund's own time (as in the Z-report), not the sale's. VAT report shows
  sales, refunds and VAT due side by side.
- **Day** = shop-local day (`locations.timezone`), cut in SQL (`at time zone`), so DST days are right.
- **Pre-aggregation.** `daily_sales_summary` (one narrow table, one row per org/location/day/dim/key).
  Dashboards and reports read only it (plus `report_serials` and `report_covers`, which read raw rows
  for a bounded range). Rebuilt per day by `ops.rebuild_summary_day` (delete + insert in one transaction,
  advisory lock). A trigger on `sales` and `refunds` marks the shop-local day dirty, so an offline sale
  that lands days late is rebuilt; the job runs every 5 minutes and a nightly job re-marks the last 3 days.
- **Reports are bounded:** at most 366 days from the screen (the database allows 400) and 5,000 rows.
  So a report is made while the request waits; only the whole-account ZIP is a background job.
  (The plan said "large exports run in the background and email a signed link"; with these bounds a
  report export is a few KB to a few MB and runs in well under a second.)
- **ZIP download** needs a signed-in owner with a fresh sign-in (see Known limits): the email links to the
  Settings page, not to a bearer URL. This is stricter than a signed link.

## Screens

| Screen                                                             | Who            | Notes                                                                                                                                                                     |
| ------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/o/<org>/dashboard`                                               | owner, manager | Tiles per business type from the summary; the "needs attention" panel is unchanged.                                                                                       |
| `/o/<org>/reports`                                                 | owner, manager | The reports this business type offers.                                                                                                                                    |
| `/o/<org>/reports/<report>?from=&to=&q=`                           | owner, manager | Date form (native date inputs), quick ranges (incl. this/last VAT period), table with totals, download links. Empty, error (bad dates) and truncated (5,000 rows) states. |
| `/o/<org>/reports/<report>/export?format=csv\|xlsx\|pdf&from=&to=` | owner, manager | Same parse, same loader, same table. 30 per hour per user.                                                                                                                |
| `/o/<org>/settings/export`                                         | owner          | Ask for the ZIP, list of requests, download when ready.                                                                                                                   |

Gating by business type: serials and brand = electronics; size/colour = clothing; covers = restaurant;
tips = café and restaurant. Others see all general reports.

## Data

- `daily_sales_summary(org_id, location_id, day, dim, key, label, sales_count, qty, gross_cents,
net_cents, vat_cents, discount_cents, tips_cents, refund_count, refund_qty, refund_gross_cents,
refund_net_cents, refund_vat_cents, built_at)`, PK `(org, location, day, dim, key)`. RLS: SELECT for
  managers/owners only; no client writes. `dim`: total, hour, tender, vat_rate, category, product,
  staff, brand, size_colour.
  - `total`: gross = sum of `amount_due_cents` (includes cash rounding and deposits); net/vat/discount
    from item lines; refund_gross = money paid back.
  - line dims (vat_rate, category, product, brand, size_colour): item lines only (deposits are outside
    VAT and show on the total row), refund side from `refund_lines` at the ORIGINAL rate.
- `report_dirty_days(org, location, day)`: no client access (deny-all policy).
- `account_exports` (status only, owners SELECT) and `account_export_files` (bytes, no client access).
- Functions: `ops.rebuild_summary_day`, `ops.rebuild_dirty_summaries`, `public.report_summary`
  (INVOKER), `report_serials`, `report_covers` (INVOKER, manager check), `public.request_account_export`,
  `get_account_export` (DEFINER, owner), `ops.account_export_begin/rows/finish/fail/mail_data/purge`.
- Migrations: `0048_report_summaries` (generated), `0049_reports_rls_and_functions`,
  `0050_account_exports` (generated), `0051_account_export_rls_and_functions` (hand-written).

## Rules

- Role: owner or manager for reports (RLS and an explicit check, so a cashier gets an error); owner for the ZIP.
- Zod: one `reportParams` schema (real dates, from <= to, <= 366 days, `q` <= 60) used by the screen and
  the export route. Invalid dates on a screen show a message and fall back to the last 30 days; on the
  export route they are a 400.
- **Formula injection:** all user-controlled text in CSV and Excel passes `safeText` (leading
  `' ` for `= + - @ TAB CR`), including shop name and titles; numbers are written as numbers.
- **ZIP contents:** 20 tables, one CSV each, plus README and manifest. Excluded: PIN hashes, lockout
  counters, device token hashes, audit log. Customer personal data is included (owner only, audited).
- **Audit:** `account.export_requested`, `account.export_ready`, `account.export_downloaded`, ids only.
  Plain report exports contain no customer data and are rate-limited, not audited.
- Limits: ZIP built in memory and stored uncompressed, 150 MB cap (a bigger account fails with
  `too_large`: contact support); files kept 7 days; one request per owner-shop per day.

## Edge cases

- Offline sale lands days late: trigger marks its day; shown within ~5 minutes of arrival.
- A product renamed or recategorised: history keeps the old label until the nightly rebuild refreshes
  the last 3 days; older days keep what they had (a rebuild of an old day would take the new name).
- Refund of a sale from a previous period: counted in the period of the refund, shown as "Refunded".
- Service-charge lines have no product: they sit under "Other (no product)" and "No category".
- Staff names come from the membership at rebuild time; an erased staff member shows as "Staff".
- Tips only exist on card payments; the tips report is for café/restaurant.
- Covers come from tab `open` events of the shop's first location (single location in v1).

## Known limits (from the audits)

- **Exchanges:** the refund side of the total, hour and staff rows is `amount_cents + credit_cents`, so
  an exchange (replacement sold at full value) nets to real money; the Payments report shows one
  "Exchange credit" row that nets to nothing.
- **Dashboard** compares today so far with the WHOLE of the same weekday last week, so it says what last
  week was rather than "up/down".
- **Covers vs spend:** covers are dated by the tab's open event (till clock), spend by the bill's
  completion; a tab opened at 23:30 and paid at 00:20 splits across two days. Spend is `amount_due`
  (service charge, deposits and rounding included), refunds not deducted.
- **Renamed or recategorised products:** history keeps the label it had when its day was last built;
  only the last 3 days refresh each night. Totals and the VAT report are unaffected (stored snapshots).
- **Tips** are not reduced by tips handed back on a void (same as the Z-report note).
- **Service-charge lines** have no product: they appear as "Other (no product)" with a quantity.
- **Deposits and cash rounding** are in takings (Payments, total) but not in the VAT report gross, which
  is item lines only.
- **ZIP:** built in memory, up to 150 MB, so a download can briefly hold a few hundred MB; ids and
  paging order by id; a shop trading while it is built can differ by a row (portability snapshot, not a ledger).
- **Fresh sign-in for the ZIP (owner decision 2026-10-14):** requesting AND downloading need a sign-in
  proof from the last 10 minutes, checked in the database (`app.recent_auth`): an authenticator code
  for owners with two-step verification, the password typed again for owners without it (a magic
  link or Google sign-in never counts). The app sends the owner to a confirm page on `TF003`.
  Every owner is emailed when an export is requested (not who asked; never the file).

## Security and privacy

Summary rows hold amounts and product/staff names only, no customer data. Exports re-check the role in the
route and in SQL. No report or export path logs row contents.

## Acceptance tests

1. RLS: sums of a day (sale + refund) for total, vat_rate, product, category, staff, tender, hour.
2. RLS: rebuild is idempotent; a late sale marks its day and the job clears it.
3. RLS: day boundaries in a UTC+14 shop (23:30 vs 00:30 local).
4. RLS: summary totals and VAT row equal `app.shift_report` of the shift that rang the sales.
5. RLS: shop B, cashier, anon read nothing; the rebuild and dirty list are not reachable by the API.
6. RLS: range, dim validation; serials (search, returned flag), covers; account export request /
   one a day / owner only / page allow-list / no secrets / download audit / expiry / purge / failure.
7. Unit: params, presets (VAT periods), every report's table, totals, formula escaping (CSV, Excel),
   ZIP contents and paging, export job and summary job behaviour.
8. e2e: two sales -> dashboard, VAT report, CSV/Excel/PDF downloads, bad requests; owner ZIP request and
   download once a day.

## Open questions

- VAT3 layout (sales / refunds / VAT due side by side): accountant to confirm.
- Tips by hour or per staff member (Tips and Gratuities Act sharing report): not built.
- Whether the nightly rebuild should also cover older days after a product rename (today: 3 days).
