---
name: new-table
description: Recipe for adding a new business table to Tillflow POS - Drizzle schema, migration, RLS policies, Shop A vs Shop B RLS test, and types. Use whenever a task needs a new table or a new tenant-owned column set.
---

# Add a table

Read `.claude/rules/db.md` first. Ask for the table name and columns if not given. Work in this order and don't skip steps; a table is not done until step 4 passes.

## 1. Drizzle schema (`src/db/schema/<domain>.ts`)

- `id uuid primary key` (UUIDv7 supplied by app/device), `org_id uuid not null references organisations(id)`, `created_at timestamptz not null default now()`.
- Money as integer `*_cents`, rates as `rate_bp`. Add `updated_at` only if rows are legitimately mutable. Append-only tables get none.
- Composite indexes with `org_id` first, e.g. `(org_id, created_at)`, plus indexes on foreign keys and any lookup columns (`(org_id, barcode)`).
- Per-org uniqueness (`unique(org_id, sku)`), never global.
- Export from `src/db/schema/index.ts`. Add Zod schemas for insert/update input alongside (drizzle-zod or hand-written).

## 2. Migration

- `pnpm db:generate` creates the DDL file in `supabase/migrations`. Review the SQL. Never edit a migration that's already on `main`.
- Local only: `pnpm db:reset` to check it applies from scratch.

## 3. RLS policies (separate hand-written migration)

- `alter table <t> enable row level security;` (consider `force row level security` for owner-bypass safety).
- One policy per allowed operation, all using the single org helper (e.g. `org_id in (select app.current_org_ids())`). SELECT `using`, INSERT `with check`, UPDATE `using` + `with check`, DELETE `using`. Omit UPDATE/DELETE policies on append-only tables.
- Role-restricted writes (owner/manager only) check the role through the same helper family, not an inline subquery.
- Child tables check their own `org_id`; never trust the parent id alone.

## 4. RLS test (`tests/rls/<table>.test.ts`)

Seed Shop A and Shop B (two orgs, a user in each) and prove, as each user:

- A can select/insert/update/delete its own rows (where the policies allow it).
- A cannot see B's rows, cannot insert with B's `org_id`, cannot update or delete B's rows, and cannot move a row to B by changing `org_id`.
- An anonymous/unauthenticated client gets nothing.
- Append-only tables reject UPDATE and DELETE for everyone.
  Run `pnpm test:rls`. It must fail if you temporarily drop the policy (check it once).

## 5. Types and wiring

- Regenerate/export inferred types (`typeof table.$inferSelect`). Update `docs/PLAN.md` section 8 if the table belongs in the data model.
- Data access goes through server code that also filters by the session's org and checks role. Zod-validate every input.

## 6. Finish

Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:rls`. For anything sensitive, ask the `tenant-isolation-auditor` agent to review. Update `docs/STATUS.md`.
