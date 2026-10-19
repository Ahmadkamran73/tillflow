# VAT and money library (Phase 1 · Step 1.1)

## Summary

`src/lib/money` is the one place where money maths, Irish VAT and rounding happen. The register, sync API, receipts and reports call it; nothing else does VAT maths. It is a pure TypeScript library (no database, no UI), so the browser register (offline) and the server (which recalculates every sale) get the same answer.

## Out of scope

- Screens, receipts layout, persistence of sales (later Phase 1 steps).
- Loading `tax_rates` from the database: callers pass the rows in (the server reads them through RLS; the register reads its IndexedDB copy).
- Weighed / fractional quantities (quantity is an integer; negative = refund).
- Tips, service charge, split tender allocation (Phase 2). `cashRound` is exported so a split-tender flow can round only its cash part.
- Refund-against-original-sale matching (refund spec, Phase 2). The library only guarantees a fully negated basket mirrors the original exactly. **Partial refunds must be built from the stored sale-line snapshot (gross, `tax_rate_bp`, `tax_amount`), never by re-running `calculateBasket`**: deal and basket-discount apportionment is over the whole line/basket, so refunding one of two deals, or one item of a discounted basket, would not reconcile (e.g. 600 + 400 with €1 off is stored as 540 + 360; recalculating the 600 alone refunds 60c too much). The refund spec adds a snapshot-based helper with a test that cumulative refunds never exceed the original per line and per rate.

## Screens

None.

## Data

No tables or columns change. The library reads rows shaped like `public.tax_rates` (`country`, `code`, `rate_bp`, `valid_from`, `valid_to` inclusive, null = open-ended), seeded in migration `0002_seed_irish_tax_rates`.

Tax categories are the `tax_rates.code` values:

| Category         | Rate (bp)                                  | Typical use                                                        |
| ---------------- | ------------------------------------------ | ------------------------------------------------------------------ |
| `STANDARD`       | 2300                                       | most goods, alcohol, soft drinks, bottled water                    |
| `REDUCED`        | 1350                                       | fuel, building services, etc.                                      |
| `SECOND_REDUCED` | 900                                        | newspapers and other goods at 9% (not served food or drink)        |
| `ZERO`           | 0                                          | cold take-away food, most food goods                               |
| `LIVESTOCK`      | 480                                        | livestock                                                          |
| `CATERING`       | 1350 until 2026-06-30, 900 from 2026-07-01 | served food and drink incl. hot drinks (follows the catering rate) |
| `HAIRDRESSING`   | 1350 until 2026-06-30, 900 from 2026-07-01 | hairdressing services                                              |

Each calculated line carries `mode`, `taxCategory`, `rateBp`, `gross`, `net` and `vat` so the sale line can snapshot them (`tax_rate_bp`, `tax_amount`). A completed sale is never recalculated.

## Rules

1. **Integer cents.** Every amount, quantity and basis-point value must be a safe integer; anything else throws `RangeError`.
2. **Prices are VAT-inclusive.** Per line: `net = roundHalfUp(gross × 10000 / (10000 + rate_bp))`, `vat = gross − net`. Never computed on the basket total.
3. **Half-up** means half away from zero, so a refund line is the exact negative of the sale line. (With the seeded Irish rates an exact half-cent cannot occur in the VAT split; it does occur in percentage discounts.)
4. **Rate lookup** by `(country, category, date)` where `valid_from ≤ date ≤ valid_to`. `date` is the shop's local calendar date (`localDate(instant, "Europe/Dublin")`), not the UTC date. No matching row, or more than one (possible in the register's offline copy, which has no overlap constraint), throws: a sale must never get a guessed rate. Served food and drink (incl. tea and coffee) map to CATERING, never SECOND_REDUCED, so they follow any future catering rate change even though both are 9% today.
5. **Eat-in vs take-away.** A product has `taxCategory` (eat-in/default) and optional `takeawayTaxCategory`. Take-away uses `takeawayTaxCategory ?? taxCategory`. The mode is set per basket; an item or deal line can override it (`mode`), and the mode used is on each output line. A meal deal has one mode for all its components (a per-component mode can be added if pilots need it). A CATERING product sold take-away without a `takeawayTaxCategory` throws (falling back to the eat-in rate would silently over-charge cold food); a take-away coffee that stays at the catering rate sets `takeawayTaxCategory: "CATERING"` explicitly. Product save (Zod) and the café/restaurant presets must also require the mapping for CATERING products (products step), so the register never hits the throw.
6. **Discounts before VAT.** Line discount (`{ amount }` cents or `{ percentBp }`) reduces the line gross toward zero. The basket discount is apportioned over item lines in proportion to their discounted gross, then VAT is split per line. A discount larger than what it applies to throws. A basket discount on a basket mixing sale and refund lines throws.
7. **Apportionment** (meal deals, basket discounts): largest remainder: each part is `floor(total × weight / Σweights)`, then the leftover cents go one each to the parts with the largest dropped fraction (ties: larger weight, then earlier line). Parts always sum exactly to the total and each is within 1c of its exact share, so a discount share never exceeds its line. With one leftover cent this is the line with the biggest fraction, usually the largest line.
8. **Meal deals.** The deal price (× qty, minus its line discount) is apportioned across components by their standalone prices; each component then takes its own category (and take-away mapping) and VAT.
9. **Deposits (Re-turn) and bag levy** are non-VAT lines: no VAT, not discounted, included in the total.
10. **5c cash rounding** applies only when the tender is cash, rounds the basket total to the nearest 5c (1–2c down, 3–4c up, mirrored for negatives) and is reported as its own `cashRounding` amount. It never changes line VAT.
11. **Reconciliation:** Σ VAT-line gross + Σ non-VAT gross = `total`; Σ line VAT = `vatTotal`; `amountDue = total + cashRounding`; `vatByRate` sums equal the line sums.
12. **Server authority:** the sync API calls `calculateBasket` with server-side prices and rates and ignores client totals (sync spec).

## Edge cases

- **Rate change at midnight:** a sale at 2026-06-30T23:30Z is 1 July 00:30 in Dublin → CATERING at 900.
- **Offline:** the register computes with its cached rates; the server recomputes on sync with its own rows. If they differ the server's figure wins (sync spec decides how that is flagged).
- **Refunds:** negative qty; discounts apply toward zero; every figure mirrors the sale.
- **Zero:** zero-priced lines and an empty basket give all-zero totals.
- **Large values:** inputs whose intermediate products leave the safe-integer range throw instead of losing precision (≈ €900 million per line at 23%).
- **Missing or overlapping rate rows / unknown category:** throws.
- **CATERING product sold take-away with no mapping:** throws.

## Security and privacy

Pure functions, no I/O, no personal data, no logging. Tenant isolation is not involved. The risk is wrong tax: covered by the tests below and the `vat-auditor` agent.

## Acceptance tests (all unit, `tests/unit/money`)

1. Given gross 123 at 2300, when split, then net 100 and VAT 23.
2. Given each seeded rate and gross in {0, 1, 99, 1000, 2399}, when split, then net + VAT = gross and a negated gross gives the exact negatives.
3. Given `roundHalfUp(5, 10)`, then 1; `roundHalfUp(-5, 10)`, then −1; `roundHalfUp(4, 10)`, then 0.
4. Given CATERING, when looked up for 2026-06-30, then 1350; for 2026-07-01, then 900.
5. Given instant 2026-06-30T23:30Z and Europe/Dublin, then local date 2026-07-01.
6. Given no row for the date or category, when looked up, then it throws.
7. Given a sandwich with `taxCategory` CATERING and `takeawayTaxCategory` ZERO, when take-away, then ZERO; when eat-in on 2026-07-01, then 900.
8. Given a €10.00 meal deal of a €4.50 CATERING main, €3.50 STANDARD drink and €2.50 ZERO side (eat-in, 2026-07-01), then parts 429 / 333 / 238 (sum 1000) with the leftover 1c on the main, and each part's VAT at its own rate.
9. Given a line of 3 × 199 with 10% off, then gross 537 (597 − 60) before VAT.
10. Given a €1.00 basket discount over lines 600 and 400, then 540 and 360.
11. Given a 15c Re-turn deposit and a 22c bag levy, then no VAT on them, no basket discount on them, and they are in the total.
12. Given total 1002 and cash tender, then rounding −2, amount due 1000; total 1003 rounds +2 to 1005; with card, rounding 0.
13. Given 1,000 random baskets (seeded), then every reconciliation rule in Rules §11 holds, and the negated basket mirrors the original.
14. Coverage for `src/lib/money/**` is 100% statements, branches, functions and lines (`pnpm test:money`).

## Open questions

- **Re-turn deposit VAT treatment:** treated as outside the scope of VAT (PLAN §12 says confirm with the accountant before go-live).
- **Hot take-away food, and tea/coffee served:** which category applies after the 1 July 2026 change (CATERING, or a new code with its own rows) is per-product data (`takeawayTaxCategory`); confirm with the accountant before the café and restaurant presets ship.
- **Budget 2027** rate changes: new migration rows, no code change. A new category (e.g. a separate hot-food code) needs a migration and an entry in `TAX_CATEGORIES`.
