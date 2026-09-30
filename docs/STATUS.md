# Tillflow POS — Status

_Last updated: 2026-09-29_

## Current phase / step

**Phase 0 · Foundations** — Step 0.4 Part 1 (local tenancy schema + RLS) done and hardened after `/security-review` (no findings) and the `tenant-isolation-auditor` agent (2 medium, several low; addressed in migration 0003). `pnpm test:rls` green locally (39 tests). Part 2 done: staging project `tillflow-staging` (eu-west-1, ref `kbtpydpigscfmvtqmkfy`, org `tline`) created, linked, migrations 0000–0003 pushed, `check-rls` OK against staging.

## Done

- [x] **0.0** Manual checklist: tools installed, accounts created
- [x] **0.1** Repo and scaffold: Next.js app, pnpm, Tailwind + shadcn, Drizzle, Vitest, Playwright, local Supabase config, folder skeleton
- [x] **0.2** Claude Code plugins (security-guidance, code-review, commit-commands, feature-dev, frontend-design, typescript-lsp) and Supabase MCP (read-only) recorded in `.claude/settings.json` and `.mcp.json`
- [x] **0.3** CLAUDE.md, `.claude/rules` (db, money, register-ui), subagents (tenant-isolation-auditor, vat-auditor, accessibility-reviewer), hooks (Prettier on edit, protect `.env*` and committed migrations, STATUS.md on compact), skills (`/new-table`, `/write-spec`), security guidance
- [x] **0.4 Part 1** Tenancy foundation (local): `organisations`, `locations`, `memberships`, `registers`, `tax_rates` (Irish rates incl. the 1 July 2026 catering/hairdressing 13.5% → 9% change), `audit_log` (append-only). Migrations `0000_tenancy_tables` (generated), `0001_rls_helpers_and_policies` and `0002_seed_irish_tax_rates` (hand-written). Helper family in schema `app`: `org_ids_with_roles` (the only memberships lookup), `current_org_ids`, `manager_org_ids`, `owner_org_ids`, `current_user_id` (the only `auth.uid()` call). RLS tests in `tests/rls` (Shop A vs Shop B, owner/manager/cashier). `scripts/check-rls.ts` + `pnpm check:rls`; `pnpm test:rls` runs it first.

- [x] **0.4 Part 2** Staging project. `.mcp.json` points the Supabase MCP at staging (`read_only=true`; run `/mcp` to reconnect). `.env.local` (local only) holds `SUPABASE_STAGING_DB_PASSWORD`, `SUPABASE_STAGING_URL`, `SUPABASE_STAGING_ANON_KEY`. Check staging with: `STAGING_CHECK_URL=<session-pooler url> pnpm check:rls --url-env=STAGING_CHECK_URL` (read-only transaction). Nothing was created or pushed in any production project.

## Next step

**0.5** per the prompts file (next step after 0.4). Before it: reconnect the MCP with `/mcp`, and consider a CI job that runs `supabase db push` to staging instead of pushing by hand.

## Design notes (0.4)

- `tax_rates` is global reference data: no `org_id`, read-only for every client role, changed only by migration. Rows before 2024-01-01 are not seeded.
- Clients get column-level grants: `pin_hash` and `device_token_hash` are never readable; org `plan`/`status`/`trial_ends_at` are not client-writable. `select *` on `memberships`/`registers` fails for signed-in users; list columns explicitly.
- Organisations are created only by the sign-up flow with the service role (no client INSERT policy).
- `memberships.user_id` has no FK to `auth.users` (auth stays swappable behind `src/lib/auth`).
- Server data access must run as the `authenticated` role with the user's JWT claims for RLS to apply; a plain `DATABASE_URL` connection as `postgres` bypasses RLS.
- `0003_harden_memberships_and_audit` (from the tenant-isolation audit): clients can no longer INSERT `memberships` or `audit_log`; server code writes both after checking the caller's role (invite/accept flow for memberships). Triggers: `location_ids` must belong to the membership's org; an org cannot lose its last owner unless closed. `touch_updated_at` pins `search_path`.
- Deferred audit items: location scoping by `location_ids` (before multi-location), owner MFA (aal2) in policies, `FORCE ROW LEVEL SECURITY`, and defining the app's non-owner DB role (`set local role authenticated` + JWT claims per request). Re-audit when `src/db` client exists.
- Not done yet: manager-invites-cashier flow.

## Open issues

- Python 3.12.10 installed per-user (winget) and `/reload-plugins` run on 2026-09-29. If the security-guidance plugin still complains, turn off the Windows "App execution aliases" for python.exe/python3.exe.
- **`jq` is not installed.** The hooks parse JSON with `node` instead, so nothing is blocked. Install it later only if wanted.
- `.claude/settings.local.json` and `.env.local` are local-only; don't commit them.
- Product decisions still open (from PLAN.md): price amount and whether per shop or per business, trial length, phone-support owner and hours.
- Confirm Re-turn deposit amounts/VAT treatment and any Budget 2027 rate changes before go-live.
