# Tillflow POS — Status

_Last updated: 2026-09-29_

## Current phase / step

**Phase 0 · Foundations** — Step 0.3 (Claude Code configuration) complete pending commit. Next up: Step 0.4.

## Done

- [x] **0.0** Manual checklist: tools installed, accounts created
- [x] **0.1** Repo and scaffold: Next.js app, pnpm, Tailwind + shadcn, Drizzle, Vitest, Playwright, local Supabase config, folder skeleton
- [x] **0.2** Claude Code plugins (security-guidance, code-review, commit-commands, feature-dev, frontend-design, typescript-lsp) and Supabase MCP (read-only) recorded in `.claude/settings.json` and `.mcp.json`
- [x] **0.3** CLAUDE.md, `.claude/rules` (db, money, register-ui), subagents (tenant-isolation-auditor, vat-auditor, accessibility-reviewer), hooks (Prettier on edit, protect `.env*` and committed migrations, STATUS.md on compact), skills (`/new-table`, `/write-spec`), security guidance

## Next step

**0.4 — Core schema, tenancy, RLS and the staging Supabase project.** Use plan mode. Start with the org-membership SQL helper, then `organisations`, `locations`, `registers`, `memberships`, `tax_rates`, each with RLS and Shop A vs Shop B tests.

## Open issues

- **Python 3.10+ is not installed** (only the Microsoft Store shortcut). The security-guidance plugin needs it. Install it and run `/reload-plugins`.
- **`jq` is not installed.** The hooks parse JSON with `node` instead, so nothing is blocked. Install it later only if wanted.
- `.claude/settings.local.json` and `.env.local` are local-only; don't commit them.
- Product decisions still open (from PLAN.md): price amount and whether per shop or per business, trial length, phone-support owner and hours.
- Confirm Re-turn deposit amounts/VAT treatment and any Budget 2027 rate changes before go-live.
