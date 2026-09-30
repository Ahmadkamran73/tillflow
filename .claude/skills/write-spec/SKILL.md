---
name: write-spec
description: Turn a feature request into a spec at docs/specs/<feature>.md with screens, data, rules, edge cases and acceptance tests. Only runs when the user types /write-spec.
disable-model-invocation: true
argument-hint: <feature request>
---

# Write a feature spec

Input: the feature request in `$ARGUMENTS` (if empty, ask for it).

1. Read `docs/PLAN.md` (scope, data model, security, compliance, UI principles) and `docs/STATUS.md`. Skim `docs/specs/` for related specs and existing code the feature touches. Don't design against a table or module that doesn't exist without saying so.
2. Ask at most three clarifying questions, and only if the answers change the design. Otherwise state assumptions in the spec.
3. Write `docs/specs/<feature-slug>.md` (kebab-case) with these sections:

   - **Summary**: what, for whom, and why, in three sentences. Roadmap phase/step it belongs to.
   - **Out of scope**: what this deliberately doesn't do.
   - **Screens**: each screen or flow, its states (empty, loading, error, offline), and who can see it (owner / manager / cashier). Register screens meet `.claude/rules/register-ui.md`.
   - **Data**: tables and columns added or changed (all with `org_id` and RLS), indexes, what is append-only, how it syncs offline (idempotency key).
   - **Rules**: business logic, permissions per role, validation (Zod), money/VAT handling via `src/lib/money`, server-side recalculation, audit-log events.
   - **Edge cases**: offline, duplicate submits, concurrent edits, refunds/voids, negative stock, empty and huge inputs, timezone/date boundaries, failed printing, GDPR (personal data, consent, deletion).
   - **Security and privacy**: tenant isolation, IDOR risks, rate limits, what must never be logged.
   - **Acceptance tests**: numbered, in given/when/then form, each marked unit / RLS / e2e. Include at least one cross-tenant RLS test if data is touched, and an offline case if the register is involved.
   - **Open questions**: anything needing my decision.

4. Keep it concrete (real field names, real amounts in cents). No implementation code beyond schema sketches.
5. Report the file path and the open questions. Don't start implementing.
