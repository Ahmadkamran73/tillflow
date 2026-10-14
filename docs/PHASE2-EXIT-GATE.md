# Phase 2 exit gate: checklist

_Updated 2026-10-14 (second pass, branch `feat/reports`). Status words: **PASSED** (evidence shown),
**FAILED**, **BLOCKED** (cannot be done until something outside this branch happens), **NOT TESTED**,
**NOT BUILT**._

## The gate

Source: `docs/PLAN.md` section 2 and `docs/PROMPTS_v1.md` (end of Part D):

> In staging, run one full trading day for each of the 5 business types (open shift → sales → refunds →
> Z-report → exports) with correct numbers. Update `docs/STATUS.md`.

**Gate status: NOT PASSED.** No trading day has been run on staging for any business type. The automated
tests below run on a local database and are evidence for the release, not the sign-off. Nothing here turns
the gate into a pass.

**Repository and staging state (read this first):**

- PR #42 (Step 2.9, reports) was squash-merged into `develop` by the owner on 2026-10-14 at 13:29 UTC
  (`c086be9`). The whole-day tests were pushed after that merge, so they are **not in `develop` yet**: they
  need a new PR.
- The merge triggered the "Migrate staging" workflow (it runs on every push to `develop` that touches
  `supabase/migrations`): run 38572202270 finished `success` at 13:29:25 UTC. So migrations `0048`-`0051`
  were applied to the **staging** Supabase project by the repository's automation, not by the assistant.
  The staging database and the Hostinger staging app were not inspected here, and whether the app has
  redeployed is unknown. (Earlier versions of this file said staging lacked those migrations: that stopped
  being true at the merge.)

## 1. Capability steps (what the gate trades on)

| Requirement                                          | Status                                                       | Evidence                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 Tenders: cash, card on own terminal, split, tips | PASSED (merged)                                              | PR #30 in `develop` (`b674b3f`); `tests/rls/tender-types`, `payments-split`; e2e `register-tenders.spec.ts`                                                         |
| 2.2 Refunds, voids, exchanges                        | PASSED (merged)                                              | PR #31/#32 (`dec9ca8`, `f36829e`); `tests/rls/refunds.test.ts`; e2e `register-refunds.spec.ts` (clothing exchange included)                                         |
| 2.3 Shifts, cash, X/Z reports                        | PASSED (merged)                                              | PR #33 (`156ef88`); `tests/rls/shifts.test.ts`; e2e `register-shifts.spec.ts`                                                                                       |
| 2.4 Inventory                                        | PASSED (merged)                                              | PR #34 (`19b860b`); e2e `inventory.spec.ts`                                                                                                                         |
| 2.5 Customers                                        | PASSED (merged)                                              | PR #35 (`27a218c`); e2e `customers.spec.ts`                                                                                                                         |
| 2.6 Café and restaurant flow                         | PASSED (merged)                                              | PR #36 (`25e1c5d`), #39 (`b0d8441`); e2e `register-cafe`, `register-restaurant`                                                                                     |
| 2.8 Bulk import (CSV/JSON)                           | PASSED (merged); Excel deferred by owner decision 2026-10-14 | PR #38-#40; Excel e2e is skipped by design ("Excel import is off in this run")                                                                                      |
| 2.9 Reports and exports                              | PASSED (merged); owner review of `0049`/`0051` not recorded  | PR #42 (`c086be9`); `docs/specs/reports.md`                                                                                                                         |
| Gift receipts (clothing preset, PLAN section 4)      | **NOT BUILT**                                                | `giftReceipt` is a preset flag that nothing reads (`grep giftReceipt src`: only its definition); the clothing onboarding card and the PLAN still list gift receipts |

## 2. Per business type: one full trading day in staging

Required for each: open shift, sales, refunds, Z-report, exports, correct numbers.

| Business type         | Staging day (the gate) | Automated whole day, local database (evidence, not the gate) |
| --------------------- | ---------------------- | ------------------------------------------------------------ |
| General / convenience | **NOT RUN**            | PASSED: `tests/e2e/trading-day.spec.ts` "general store"      |
| Electronics & phones  | **NOT RUN**            | PASSED: "electronics"                                        |
| Clothing & footwear   | **NOT RUN**            | PASSED: "clothing"                                           |
| Café                  | **NOT RUN**            | PASSED: "café"                                               |
| Restaurant            | **NOT RUN**            | PASSED: "restaurant"                                         |

What each automated day does (through the real screens, on the production build, in a shop whose time zone is
NOT the UTC day): sign up and onboard as the type, create its products, pair a till and open a shift (100.00
float), sell, refund (and exchange for clothing), close the shift, then check against an independent
calculator (`tests/e2e/day/ledger.ts`, which imports nothing from `src/`; unit-tested in
`tests/unit/day-ledger.test.ts`): the stored sales, the server's Z-report, the back-office Z page, the
dashboard tiles (exact amounts), sales by day, VAT by rate (sales, refunds, VAT due), payments by type, sales
by hour (hour read from the stored time with `Intl`), the line reports, each exported as CSV, Excel and PDF and
compared with the table on screen (CSV and Excel cell by cell; the PDF row by row, in order, with exactly the
same text), and finally that a second business gets 404 on every page, export and download of the first and
sees empty books of its own.

How the expected values stay independent: every number comes from the scenario (amounts typed by hand in the
test) and the calculator (VAT = round(gross x rate / (10000 + rate)), half away from zero, integers; refunds as
a share of the stored line; 5c rounding of the cash share; drawer = float + cash sales - cash refunds). The only
imports from application code are two display labels (business-type names and the `BusinessType` type). The
tests were mutation-checked: breaking the VAT-due column, a PDF total (`€60.557` for `€60.55`) and the day cut
(a naive 24-hour day) each make a test fail.

| Type        | Specific coverage                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General     | barcode products at 23%, 13.5%, 0%; 10% line discount; Re-turn deposit outside VAT; 5c cash rounding (cash share only); split card + cash; card refund of one of two candles; stock (opening - sold + returned); Z over/short -0.05; product report |
| Electronics | serial/IMEI prompt and bad-serial refusal; refund found by IMEI; serials sold report (receipt, returned flag, search by part of a serial, exported); brand report; no 5c rounding for cash                                                          |
| Clothing    | size x colour matrix, variant picker at the till; exchange for a dearer jacket (credit 20.00 + 80.00 card); plain refund; exchange credit as its own payment row; size/colour report                                                                |
| Café        | required modifier group (Large +0.50); eat-in 9% against take-away 0% sandwich; 23% cola; card tip 1.00; refund of one latte; tips report and tile                                                                                                  |
| Restaurant  | table with 4 guests, seats, split bill by seat, 10% service charge taxed at each item's rate, card tip 3.00, second table of 2 guests, refund of one steak with its service charge; covers (6), spend per cover (14.67), tips                       |

### What the automated days do not cover, and where else it is covered

| Not in the whole-day tests                                                   | Covered elsewhere?   | Evidence                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cash in/out and its effect on expected cash                                  | Yes                  | `register-shifts.spec.ts` (cash in/out, X-report, close 2.00 short, offline close)                                                                                                                                                                                                      |
| Manager-PIN approvals (refund limit, discount, void of a sent line, no-sale) | Yes                  | `register-refunds`, `register-pairing`, `register-restaurant` specs; `tests/rls/refunds`, `pins`, `register-events`                                                                                                                                                                     |
| Offline selling and syncing                                                  | Yes                  | `register-sync.spec.ts` (20 offline sales, reload, replay), `register-tenders` (offline card), `register-refunds` (offline refund), `register-shifts`                                                                                                                                   |
| A whole offline day followed by reports                                      | **No**               | the pieces are covered, the combination is not (risk: low to medium)                                                                                                                                                                                                                    |
| Kitchen/bar tickets, courses, fire, void of a sent line                      | Yes                  | `register-cafe.spec.ts`, `register-restaurant.spec.ts`                                                                                                                                                                                                                                  |
| Moving and merging tables                                                    | Partly               | `tests/unit/restaurant-tabs.test.ts` (logic). NEW `tests/rls/restaurant.test.ts`: the server records `transfer` and `merge` events, keeps only allow-listed facts, replay-safe. **No e2e** of the dialogs                                                                               |
| Void of a whole sale                                                         | Yes                  | `register-refunds.spec.ts` ("a void reverses the whole sale")                                                                                                                                                                                                                           |
| Gift receipts                                                                | **Not built**        | see section 1                                                                                                                                                                                                                                                                           |
| Warranty end date                                                            | Yes (unit)           | `tests/unit/register-receipt.test.ts`                                                                                                                                                                                                                                                   |
| Customers                                                                    | Yes                  | `customers.spec.ts`, `tests/rls/customers`                                                                                                                                                                                                                                              |
| Bulk import                                                                  | Yes                  | `import.spec.ts`, `import-suppliers.spec.ts`, `tests/rls/imports*`                                                                                                                                                                                                                      |
| Daylight-saving days in reports                                              | **Was not; now yes** | NEW `tests/rls/reports.test.ts` "days on a clock-change weekend": 29 March 2026 (23 h) and 25 October 2026 (25 h) in Europe/Dublin, each side of both midnights, the skipped and the repeated hour; it fails against a naive 24-hour day. The clocks next change on **25 October 2026** |
| A sale that straddles local midnight                                         | Yes                  | `tests/rls/reports.test.ts` (UTC+14: 23:30 and 00:30 local) and the DST tests                                                                                                                                                                                                           |
| Discounts beyond the general store's 10% line discount                       | Yes                  | `tests/unit/money` (basket and line discounts, 100% coverage), `register-pairing.spec.ts` (an over-limit discount needs a manager), `register-discount-limit.test.ts`                                                                                                                   |
| Real printers, cash drawer, card terminals, barcode scanners                 | **No**               | manual only (`docs/PRINTING.md`); the browser-print fallback is exercised                                                                                                                                                                                                               |
| Isolation at database level                                                  | Yes                  | `tests/rls/*` (Shop A vs Shop B). The whole-day tests check isolation at page, export and download level                                                                                                                                                                                |

Important uncovered release risks, most important first: (1) no staging trading days, and no real printer or
card terminal run; (2) gift receipts are advertised for clothing but not built; (3) no combined offline-day
test; (4) no e2e of moving/merging tables; (5) the Hostinger large export and the screen-reader and LibreOffice
checks (section 3); (6) accountant answers (VAT3 layout, hot take-away rate, service-charge VAT, Budget 2027).

Why the staging gate is NOT RUN: it needs a person at a tablet with the shop's own printer and card terminal,
for five business types, on the staging app. It is no longer waiting for migrations (see the top of this file).

## 3. Release-readiness of the whole-day tests and Step 2.9

| Check                                                              | Status                                  | Evidence                                                                                                                                  |
| ------------------------------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Lint, typecheck, `check:imports`, `check:rls`, `db:generate` empty | PASSED                                  | run 2026-10-14 after the last change; `check:rls` 49 tables, all with RLS and a policy                                                    |
| Unit + RLS tests (`vitest run`, twice in a row)                    | PASSED                                  | 88 files passed, 2 skipped; 1202 tests passed, 4 skipped, 1 todo, both runs, after `supabase db reset --local`                            |
| Money coverage                                                     | PASSED                                  | 100% statements and branches                                                                                                              |
| Full Playwright suite (final build)                                | PASSED                                  | 76 tests: 75 passed, 1 skipped (Excel import, off by design), 0 failed, 0 flaky, 8.5 min; `CI=1 playwright test --workers=2 --reporter=list,json`; the exit code was read from a file written right after the command (no pipeline) |
| `/security-review` of the Step 2.9 branch                          | PASSED, no finding at confidence 8+     | two read-only passes                                                                                                                      |
| VAT report re-audit (vat-auditor)                                  | PASSED, fixes applied                   | STATUS.md                                                                                                                                 |
| Excel opens the exports                                            | PASSED (Excel 16.0 only)                | `docs/specs/reports.md` "Compatibility check"                                                                                             |
| LibreOffice, Google Sheets, Mac Excel                              | NOT TESTED                              | not installed / not available                                                                                                             |
| Large account ZIP, local                                           | PASSED (found and fixed a real problem) | 150,000 sales / 450,000 lines: ZIP 54.3 MB, 0 bad CRCs, every table's rows present, peak 320 MB, 70 s                                     |
| Large account ZIP on Hostinger                                     | **NOT TESTED**                          | needs the staging app and the host's memory limits; procedure in `docs/specs/reports.md`                                                  |
| Screen reader pass (NVDA/VoiceOver)                                | **NOT TESTED**                          | the accessibility-tree test passes (`reports-a11y.spec.ts`); a person with a screen reader has not run it                                 |
| VAT3 layout confirmed by the accountant                            | **BLOCKED: no response**                | proposal in `docs/specs/vat3-layout-proposal.md`                                                                                          |
| Owner review of `0049` and `0051`                                  | NOT RECORDED                            | the PR was merged by the owner; no review notes exist in the repository                                                                   |
| PDF export assertions read the PDF                                 | PASSED (strengthened)                   | title, page count, headings and every row, in order, whole-row exact; mutation-checked                                                    |
| `import-sandbox.test.ts` file-level failure                        | FIXED (a test false positive)           | see below                                                                                                                                 |

### The `import-sandbox.test.ts` failure

- **Symptom:** now and then the file fails while all its tests pass: `AssertionError: child N still alive`, from
  the file's `afterAll`, which waits one second for every child process the tests started to be gone.
- **Reproduced:** 2 of 12 full-suite runs without instrumentation, and on the first run with instrumentation.
  Not reproduced in 6 runs of the file alone (3 of them with 24 busy processes on 16 threads): it needs the full
  suite running.
- **Cause (evidence):** the instrumented run printed the process behind the pid: an unrelated `cmd.exe`, created
  35 seconds before, started by the assistant's shell tool. The sandbox child with that pid had exited long
  before; Windows reused the id, and `process.kill(pid, 0)` cannot tell the two apart. So it is a false positive
  of the test, not an orphaned sandbox child.
- **Fix (not a relaxation):** if a pid is still alive after the second, its command line is read and the check
  fails only if it looks like a sandbox child (`--max-old-space-size=` or `--allow-fs-read=`), or if the command
  line cannot be read (fail closed). Three new tests prove that a live sandbox-like process still fails, that an
  unrelated live process does not, and that an exited process is gone.
- **Not proven:** that it never happens on Linux/CI (never seen there); that no other cause exists (the evidence
  is for the one occurrence that was instrumented).

Notes:

- The two RLS failures in `shifts.test.ts` ("flags a close whose figures differ", "flags a close that had refused
  documents") appear when the RLS suite runs after a full Playwright run, because the e2e runs leave committed
  `shift_closes` rows that those tests read unfiltered. Run `supabase db reset --local` between the two.
- "destination stream closed early" is logged by Next.js dozens of times in a full e2e run, in specs that do not
  touch the new code too. All tests still pass. Cause not found.

## 4. Remaining blockers (nothing here is claimed done)

1. A new PR for the whole-day tests (they are on `feat/reports`, not in `develop`).
2. Five trading days on staging (one per business type), with the numbers checked against the Z-report, the VAT
   report and the payments report; record the results in `docs/STATUS.md`. First confirm what staging runs
   (database migrations 0048-0051 were applied by the merge; the app deployment was not checked).
3. A large-account export on the Hostinger staging app (procedure in `docs/specs/reports.md`).
4. A screen-reader pass by a person; a LibreOffice check.
5. The accountant's answer on the VAT3 layout (`docs/specs/vat3-layout-proposal.md`).
6. Decide on gift receipts: build them, or remove them from the clothing card and the PLAN.
7. Accountant items already open in STATUS.md: hot take-away rate, service-charge VAT, Budget 2027 rates.
