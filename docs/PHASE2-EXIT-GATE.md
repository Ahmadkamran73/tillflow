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

| Business type         | Status            | Local evidence only (not the gate)                                                                                                                                                |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| General / convenience | BLOCKED (staging) | e2e: cash/card sales, receipt, refund and void, shift open/close with Z, reports + VAT + CSV/Excel/PDF exports (`reports.spec.ts`). Each piece passes, no single "whole day" test |
| Electronics & phones  | BLOCKED (staging) | onboarding and product specs for the type; serial/IMEI prompt and serial lookup covered by unit and RLS tests only (`report_serials`), no till e2e of a serial sale               |
| Clothing & footwear   | BLOCKED (staging) | exchange flow e2e (`register-refunds.spec.ts`); size/colour report by RLS and unit tests only, no till e2e                                                                        |
| Café                  | BLOCKED (staging) | `register-cafe.spec.ts` (modifiers, take-away VAT, tickets, tips)                                                                                                                 |
| Restaurant            | BLOCKED (staging) | `register-restaurant.spec.ts` (table, courses, split by seat, service charge, void, pro-rata refund)                                                                              |

Why blocked: staging runs `develop` with migrations up to 0047; `0048`-`0051` are not applied (the owner asked
that nothing be applied until PR #42 is reviewed), and the days themselves need a person at a tablet with the
shop's real printer and card terminal setup. A local automated "trading day per type" does not exist; it
would be evidence but not the gate.

## 3. Release-readiness of Step 2.9 (evidence for PR #42)

| Check                                                              | Status                                                       | Evidence                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Lint, typecheck, `check:imports`, `check:rls`, `db:generate` empty | PASSED                                                       | run 2026-10-14 on this branch                                                                                  |
| Unit tests                                                         | PASSED                                                       | 1186 passed, 4 skipped, 1 todo                                                                                 |
| RLS tests                                                          | PASSED                                                       | 358 passed (after `supabase db reset --local`; see note)                                                       |
| Money coverage                                                     | PASSED                                                       | 100% statements and branches                                                                                   |
| Production build                                                   | PASSED                                                       | `pnpm build`                                                                                                   |
| Full Playwright suite                                              | PASSED (last full run before the final edits; see section 4) | log `pw-full` below                                                                                            |
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
