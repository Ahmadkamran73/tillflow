# Phase 2 exit gate: staging runbook

Run by a person on **staging** (`https://staging.tillflow.ie`, never production). Nothing here is passed until the result
tables below are filled in by whoever ran it. Staging was checked on 2026-10-15: `/api/health` showed `database` ok,
`jobs` ok, commit `c086be9` (Step 2.9 code, migrations 0048-0051 applied by the merge workflow).

## A. One trading day per business type (5 runs)

Use a NEW staging shop per type (sign up, onboard as that type, set the shop time zone you will test in).
Every run: pair a till, open a shift with a **100.00 float**, trade, refund, close the shift, then check the numbers.
The exact items, prices, tenders and refunds are the scenarios in `tests/e2e/trading-day.spec.ts` (one `test` per type);
type the same amounts by hand and compare with the same expected values the test uses.

| Type        | Scenario in the test (line) | Counted cash to enter at close | Expected cash in drawer   | Other numbers to check                                    |
| ----------- | --------------------------- | ------------------------------ | ------------------------- | --------------------------------------------------------- |
| General     | "general store" (~362)      | 130.50                         | 130.55 (over/short -0.05) | VAT 23/13.5/0, deposit outside VAT, 5c cash rounding      |
| Electronics | "electronics" (~471)        | 399.00                         | 399.00                    | serials report, refund by IMEI, no 5c rounding            |
| Clothing    | "clothing" (~638)           | 115.00                         | 115.00                    | exchange credit row, size/colour report                   |
| Café        | "café" (~732)               | 109.50                         | 109.50                    | eat-in 9% vs take-away 0%, tip 1.00, tips report          |
| Restaurant  | "restaurant" (~856)         | 115.40                         | 115.40                    | 6 covers, spend per cover 14.67, service charge, tip 3.00 |

For each run check, and tick:

1. The X-report before closing and the Z-report after (till print and back-office page) show the same totals.
2. Reports > Sales by day, VAT by rate, Payments: totals equal the Z-report (sales VAT, refund VAT, net VAT due).
3. Download CSV, Excel and PDF of VAT by rate and Sales by day: each equals the table on screen; no cell starts with `=`.
4. Dashboard tiles (after the 5-minute summary job): today's sales match the Z.
5. A second shop (another account) cannot open any URL of the first (404).
6. Card total equals what the shop's own terminal report says (use any figure; this is the recorded-tender control).

### Automated staging run (screens only, no database access)

`pnpm exec playwright test -c playwright.staging.config.ts` signs in to staging with the account in `.env.local`
(`STAGING_E2E_EMAIL` / `_PASSWORD` for the general store; `STAGING_E2E_<TYPE>_EMAIL` / `_PASSWORD` for the others),
creates its own tagged products, pairs a till, trades the general-store day above, closes the shift and checks the
Z page, Sales by day, VAT by rate and Payments against the independent calculator, then the CSV, Excel and PDF
exports against the screen. It refuses to run against any host that is not `staging.*` or localhost. Only the
general-store day exists so far; the other four need their own staging account (one per business type).

**Staging run 2026-10-15 (general store, commit `9ac1a02`):** open shift, 3 sales, 1 refund, Z (including over/short
-0.05), Sales by day, VAT by rate, Payments and the CSV and Excel exports all matched. **The PDF export FAILED on
staging** (redirect with `export=failed`; staging error log: `Cannot find module .../pdfkit/js/standard-fonts/Helvetica.cjs`):
the deployed bundle lacked pdfkit's `.cjs` font files because file tracing only saw the `.mjs` ones (the
`@react-pdf/renderer` 4.9.0 bump from Dependabot PR #44). Fixed in `next.config.ts`
(`outputFileTracingIncludes` for the export route; checked in the local build trace). Re-run after the fix is deployed.

## B. Large export on Hostinger

Procedure: `docs/specs/reports.md` ("Large export"). Needs a staging shop with a large history; seed it with
`scripts/large-export-check.ts --allow-remote` only against staging, with the owner's consent. Record peak memory and
whether the app stayed up.

## C. Screen reader pass (NVDA on Windows or VoiceOver)

Walk: sign in, Reports index, one report table, export buttons, dashboard, Settings > Export all my data (confirm
page), register (pay, refund, shift close). Note anything unlabelled, any focus loss, any silent status message.

## D. Questions for the accountant (one message)

1. VAT3 layout: are sales VAT, refund VAT and VAT due as separate columns right? (`docs/specs/vat3-layout-proposal.md`)
2. Rate for heated take-away sandwiches and other hot take-away food from 1 July 2026.
3. Service charge: VAT at each item's rate (current) or a flat rate?
4. Refunds dated by the refund day (current) or by the original sale?
5. Any Budget 2027 rate change before go-live.

## Results (fill in; leave blank until done)

| Item                        | Date       | Run by                    | Result (pass/fail + notes)                                                        |
| --------------------------- | ---------- | ------------------------- | --------------------------------------------------------------------------------- |
| Day: general                |            |                           |                                                                                   |
| Day: electronics            |            |                           |                                                                                   |
| Day: clothing               |            |                           |                                                                                   |
| Day: café                   |            |                           |                                                                                   |
| Day: restaurant             |            |                           |                                                                                   |
| Hostinger large export      |            |                           |                                                                                   |
| Screen reader               |            |                           |                                                                                   |
| LibreOffice opens samples   | 2026-10-15 | Claude (headless convert) | pass: 0 formula cells in xlsx and csv, text and accents intact; not viewed by eye |
| Accountant answers          |            |                           |                                                                                   |
| Owner review of 0049 / 0051 |            |                           |                                                                                   |
