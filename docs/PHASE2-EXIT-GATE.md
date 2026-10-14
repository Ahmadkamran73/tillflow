# Phase 2 exit gate: checklist

_Prepared 2026-10-14 on branch `feat/reports` (PR #42, not merged). Status words: **PASSED** (evidence shown),
**FAILED**, **BLOCKED** (cannot be done until something outside this branch happens), **NOT TESTED**._

## The gate

Source: `docs/PLAN.md` section 2 and `docs/PROMPTS_v1.md` (end of Part D):

> In staging, run one full trading day for each of the 5 business types (open shift → sales → refunds →
> Z-report → exports) with correct numbers. Update `docs/STATUS.md`.

**Gate status: NOT PASSED. BLOCKED on staging.** No trading day has been run on staging for any business
type, and staging does not yet have the reports migrations. Nothing below turns this into a pass.

## 1. Capability steps (what the gate trades on)

| Requirement                                          | Status                                                       | Evidence                                                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Tenders: cash, card on own terminal, split, tips | PASSED (merged)                                              | PR #30 in `develop` (`b674b3f`); `tests/rls/tender-types`, `payments-split`; e2e `register-tenders.spec.ts` in the full run |
| 2.2 Refunds, voids, exchanges                        | PASSED (merged)                                              | PR #31/#32 (`dec9ca8`, `f36829e`); `tests/rls/refunds.test.ts`; e2e `register-refunds.spec.ts` (clothing exchange included) |
| 2.3 Shifts, cash, X/Z reports                        | PASSED (merged)                                              | PR #33 (`156ef88`); `tests/rls/shifts.test.ts`; e2e `register-shifts.spec.ts`                                               |
| 2.4 Inventory                                        | PASSED (merged)                                              | PR #34 (`19b860b`); e2e `inventory.spec.ts`                                                                                 |
| 2.5 Customers                                        | PASSED (merged)                                              | PR #35 (`27a218c`); e2e `customers.spec.ts`                                                                                 |
| 2.6 Café and restaurant flow                         | PASSED (merged)                                              | PR #36 (`25e1c5d`), #39 (`b0d8441`); e2e `register-cafe`, `register-restaurant`                                             |
| 2.8 Bulk import (CSV/JSON)                           | PASSED (merged); Excel deferred by owner decision 2026-10-14 | PR #38-#40; Excel e2e is skipped by design ("Excel import is off in this run")                                              |
| 2.9 Reports and exports                              | BUILT, **PR #42 OPEN, NOT MERGED**                           | `docs/specs/reports.md`; checks in section 3                                                                                |

## 2. Per business type: one full trading day in staging

Required for each: open shift, sales, refunds, Z-report, exports, correct numbers.

| Business type         | Staging day (the gate) | Automated whole day, local database (evidence, not the gate)          |
| --------------------- | ---------------------- | --------------------------------------------------------------------- |
| General / convenience | **BLOCKED**            | PASSED: `tests/e2e/trading-day.spec.ts` "general store" (43 s)        |
| Electronics & phones  | **BLOCKED**            | PASSED: "electronics" (48 s)                                          |
| Clothing & footwear   | **BLOCKED**            | PASSED: "clothing" (41 s)                                             |
| Café                  | **BLOCKED**            | PASSED: "café" (44 s)                                                 |
| Restaurant            | **BLOCKED**            | PASSED: "restaurant" (47 s)                                           |

What each automated day does (all through the real screens, on the production build, in a shop whose
time zone is NOT the UTC day): sign up and onboard as the type, create its products, pair a till and open
a shift (100.00 float), sell, refund (and exchange for clothing), close the shift, then check against an
independent calculator (`tests/e2e/day/ledger.ts`, shares no code with `src/lib/money`; itself unit
tested in `tests/unit/day-ledger.test.ts`): the stored sales, the server's Z-report, the back-office Z page,
the dashboard tiles, sales by day, VAT by rate (sales, refunds, VAT due), payments by type, sales by hour
(hour read from the stored time with `Intl`), the line reports, each exported as CSV, Excel and PDF and
compared cell by cell with the table on screen, and finally that a second business gets 404 on every page,
export and download of the first and sees empty books of its own.

| Type        | Specific coverage                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| General     | barcode products at 23%, 13.5%, 0%; 10% line discount; Re-turn deposit outside VAT; 5c cash rounding (cash share only); split card + cash; card refund of one of two candles; stock (opening - sold + returned); Z over/short -0.05; product report |
| Electronics | serial/IMEI prompt and bad-serial refusal; refund found by IMEI; serials sold report (receipt, returned flag, search by part of a serial, exported); brand report; no 5c rounding for cash |
| Clothing    | size x colour matrix, variant picker at the till; exchange for a dearer jacket (credit 20.00 + 80.00 card); plain refund; exchange credit as its own payment row; size/colour report |
| Café        | required modifier group (Large +0.50); eat-in 9% against take-away 0% sandwich; 23% cola; card tip 1.00; refund of one latte; tips report and tile |
| Restaurant  | table with 4 guests, seats, split bill by seat, 10% service charge taxed at each item's rate, card tip 3.00, second table of 2 guests, refund of one steak with its service charge; covers (6), spend per cover (14.67), tips |

**Not covered by these automated days** (some are covered by other specs): cash in/out and manager-PIN
approvals, offline selling, kitchen/bar tickets and course firing, tab transfer/merge, void of a whole sale,
gift receipts, warranty dates, customers, bulk import, daylight-saving days, a sale that straddles local
midnight (the RLS suite has the UTC+14 23:30/00:30 case), discounts other than the general store's line
discount, real printers and card terminals. The "tenant isolation" check is at the page/export/download
level; the database level is `tests/rls`.

Why the staging gate stays BLOCKED: staging runs `develop` with migrations up to 0047; `0048`-`0051` are not
applied (nothing is applied until PR #42 is reviewed and merged), and the days themselves need a person at
a tablet with the shop's own printer and card terminal. **The gate is NOT PASSED.**

## 3. Release-readiness of Step 2.9 (evidence for PR #42)

| Check                                                              | Status                                                       | Evidence                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Lint, typecheck, `check:imports`, `check:rls`, `db:generate` empty | PASSED                                                       | run 2026-10-14 on this branch                                                                                  |
| Unit tests                                                         | PASSED                                                       | 1195 passed, 4 skipped, 1 todo (unit + RLS files together)                                                                                 |
| RLS tests                                                          | PASSED                                                       | 358 passed (after `supabase db reset --local`; see note)                                                       |
| Money coverage                                                     | PASSED                                                       | 100% statements and branches                                                                                   |
| Production build                                                   | PASSED                                                       | `pnpm build`                                                                                                   |
| Full Playwright suite | PASSED | final build, `CI=1 playwright test --workers=2`: 76 tests, 75 passed, 1 skipped (Excel import, off by design), 0 failed, 0 flaky, 9.6 min; exit code 0 read from a file written right after the command (no pipeline) |
| `/security-review` on the branch                                   | PASSED, no finding at confidence 8+                          | two read-only passes, files read listed in the PR                                                              |
| VAT report re-audit (vat-auditor)                                  | PASSED, fixes applied                                        | STATUS.md                                                                                                      |
| Excel opens the exports                                            | PASSED (Excel 16.0 only)                                     | `docs/specs/reports.md` "Compatibility check"                                                                  |
| LibreOffice, Google Sheets, Mac Excel                              | NOT TESTED                                                   | not installed / not available                                                                                  |
| Large account ZIP, local                                           | PASSED (found and fixed a real problem)                      | 150,000 sales / 450,000 lines: ZIP 54.3 MB, 0 bad CRCs, every table's rows present, peak 320 MB, 70 s to build |
| Large account ZIP on Hostinger                                     | **BLOCKED / NOT TESTED**                                     | needs the staging app and the host's memory limits; procedure in `docs/specs/reports.md`                       |
| Screen reader pass (NVDA/VoiceOver)                                | **NOT TESTED**                                               | accessibility-tree test passes (`reports-a11y.spec.ts`); a person with a screen reader has not run it          |
| VAT3 layout confirmed by the accountant                            | **BLOCKED: no response**                                     | proposal in `docs/specs/vat3-layout-proposal.md`                                                               |
| Owner review of `0049` and `0051`                                  | NOT DONE                                                     | listed as wanted in the PR                                                                                     |

Notes:

- The two RLS failures seen before the reset (`shifts.test.ts`: "flags a close whose figures differ", "flags a close
  that had refused documents") are the known leftover-data problem: those tests read `shift_closes` unfiltered and a
  full Playwright run leaves committed rows. Run `supabase db reset --local` between a full e2e run and the RLS suite.
- "destination stream closed early" is logged by Next.js 41 times in the final full run, in the register specs too. All
  tests still passed. Cause not found.

## 4. Remaining blockers (nothing here is claimed done)

1. Merge PR #42 after the owner reviews `0049` and `0051`, then apply migrations 0048-0051 to staging.
2. Five trading days on staging (one per business type), with the numbers checked against the Z-report, the VAT
   report and the payments report; record the results in `docs/STATUS.md`.
3. A large-account export on the Hostinger staging app (procedure in `docs/specs/reports.md`).
4. A screen-reader pass by a person; LibreOffice check.
5. The accountant's answer on the VAT3 layout (`docs/specs/vat3-layout-proposal.md`).
6. Accountant items already open in STATUS.md: hot take-away rate, service-charge VAT, Budget 2027 rates.
