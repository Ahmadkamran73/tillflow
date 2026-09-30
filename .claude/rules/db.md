---
paths:
  - "supabase/**"
  - "src/db/**"
---

# Database rules

- **Every business table**: `org_id uuid not null` referencing `organisations`, `alter table ... enable row level security`, at least one policy per operation you allow, and an RLS test in `tests/rls` in the same PR. No policy means no access; never leave RLS off "for now".
- **One SQL helper** returns the current user's org ids (e.g. `app.current_org_ids()`). Every policy calls it. Never inline the memberships subquery in a policy, so a change of auth provider touches one function.
- **Migrations are immutable after merge.** Never edit a migration that is on `main`; write a new one. Fix mistakes forward. (A hook blocks edits to committed migration files.)
- **Generated vs hand-written**: drizzle-kit generates DDL; RLS policies, helper functions and triggers are hand-written SQL migrations. Keep them in separate, clearly named migrations.
- **IDs are UUIDv7**, generated on the device or in app code, never `serial`. Table PK: `id uuid primary key` with no random default that could mask a missing client id.
- **Indexes**: index `org_id` on every table, usually as the leading column of a composite (`(org_id, created_at)`, `(org_id, barcode)`). Foreign keys get indexes too.
- **Money columns** are `integer` cents (`*_cents`) or `rate_bp` basis points. Never `numeric`/`float` for money.
- **Append-only tables** (`stock_movements`, `audit_log`, completed `sales`/`sale_lines`/`payments`): no UPDATE or DELETE policy; corrections are new rows.
- **Service role** bypasses RLS: only in server jobs and migrations/seed scripts, never in code reachable from a user request.
- **Never run destructive SQL** (`drop`, `truncate`, `db reset`) against anything but the local database. Never use the production project.
- Add `created_at timestamptz not null default now()`; add `updated_at` only on tables that are legitimately mutable.
- After a schema change, run `pnpm test:rls` and regenerate types.
