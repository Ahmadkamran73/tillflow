@AGENTS.md

# Tillflow POS

Cloud, offline-capable point of sale for Irish retail shops, cafés and restaurants (tillflow.ie): multi-tenant, EU-hosted, Irish VAT built in, no card payments integrated in v1.

@docs/PLAN.md for full context; @docs/STATUS.md for current progress.

## Stack

TypeScript (strict) · Next.js App Router + React · Tailwind + shadcn/ui · Supabase Postgres (eu-west-1) with RLS · Drizzle ORM/drizzle-kit · Supabase Auth (behind `src/lib/auth`) · Zod · Dexie/IndexedDB offline outbox · Serwist PWA · pg-boss jobs (Postgres) · Postgres rate limits and error log · pino · Resend · Vitest, Playwright, SQL RLS tests · pnpm.

## Commands

| Command            | Purpose                                                      |
| ------------------ | ------------------------------------------------------------ |
| `pnpm dev`         | Next dev server                                              |
| `pnpm lint`        | ESLint                                                       |
| `pnpm typecheck`   | `next typegen` + `tsc --noEmit`                              |
| `pnpm test`        | Vitest unit tests                                            |
| `pnpm test:rls`    | RLS tests (Shop A vs Shop B) in `tests/rls`                  |
| `pnpm test:e2e`    | Playwright                                                   |
| `pnpm db:generate` | drizzle-kit: schema → new migration in `supabase/migrations` |
| `pnpm db:migrate`  | Apply migrations (local/staging only)                        |
| `pnpm db:reset`    | `supabase db reset` (local only)                             |
| `pnpm verify`      | lint + typecheck + test + build                              |

## Folder map

- `src/app/(admin)` back office · `(auth)` sign-in/up · `(register)` till PWA · `api/v1` sync + webhooks
- `src/components/ui` shadcn components
- `src/db/schema` Drizzle schema (one file per domain)
- `src/lib/auth` the only place that calls the auth provider
- `src/lib/money` integer-cents money and VAT maths
- `src/lib/sync` offline outbox and sync
- `src/lib/storage` file storage wrapper (create when first needed)
- `supabase/migrations` generated SQL + hand-written RLS; `tests/{unit,rls,e2e}`
- `docs/specs/<feature>.md` feature specs (`/write-spec`)

## NON-NEGOTIABLE rules

**Tenancy and data**

- Every business table has `org_id`, RLS enabled, a policy, and an RLS test in the same PR.
- Completed sales are never updated. Corrections are refunds/voids (new rows).
- Never execute user-supplied SQL. Imports are parsed as CSV/Excel/JSON only.

**Money**

- Money is integer cents. All VAT and rounding goes through `src/lib/money`. Never inline maths.
- The server recalculates every price and total. Never trust client totals.

**Input and access**

- Validate every input with Zod. Check the caller's role in every server action and route handler.

**Secrets and privacy**

- Never log personal data. Never hard-code secrets.
- Never ask me to paste secrets into chat.
- Never touch production credentials or the production Supabase project.

**Portability**

- All auth calls go through `src/lib/auth`.
- RLS policies use ONE SQL helper for the current user's orgs. Never repeat the membership subquery.
- File storage sits behind `src/lib/storage`.
- Background jobs run in pg-boss (`src/lib/jobs`, Postgres queue), not Supabase Edge Functions. No third-party error, rate-limit or job services: errors, rate limits and jobs live in our Postgres (see `docs/DEPLOY.md`).
- Privileged database access (RLS-bypassing, service role) lives ONLY in `src/lib/ops/db.ts` (which calls `ops.*` SECURITY DEFINER functions and never touches tables) and the pg-boss job handlers. `pnpm check:imports` enforces this in CI.

## Definition of done

- `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm test:rls` all pass.
- Update `docs/STATUS.md` at the end of every task.
- For auth, RLS, money, sync or payments changes: run `/security-review` and the `tenant-isolation-auditor` agent before merge.

## Working notes

- Path-scoped rules live in `.claude/rules/` (db, money, register-ui). Subagents in `.claude/agents/`, skills in `.claude/skills/` (`/new-table`, `/write-spec`).
- Hooks (`.claude/settings.json`): Prettier on edit; `.env*` and committed migrations are write-protected; STATUS.md re-printed after compaction. If a hook blocks you, add a new migration or ask me. Don't work around it.
- This Next.js has breaking changes: read the relevant guide in `node_modules/next/dist/docs/` before writing Next code.
