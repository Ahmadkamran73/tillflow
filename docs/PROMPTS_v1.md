# Tillflow POS — Claude Code Build Prompts (zero to launch)

_Companion to `TILLFLOW_POS_PLAN.md` · 29 September 2026_

How to use this file:

- Work top to bottom. Each **Step** is one Claude Code task = one branch = one pull request.
- Every step tells you **how to start the session**, gives the **prompt to paste**, says **when it's done**, and what to do **after** (commit, compact or clear).
- Step 0.0 tells you to put `TILLFLOW_POS_PLAN.md` in the repo as `docs/PLAN.md` — every prompt points Claude at it.
- Phase 0 is automated: Claude Code installs tools, creates the repo, staging database, CI and hosting config. You only do sign-ins, accounts, secrets and DNS.
- Claude Code features change often. If a command below isn't recognised, check the docs: <https://code.claude.com/docs/en/overview>.

---

## Part A — Session rules (read once, follow every time)

| Situation                                                                    | What to do                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Starting a new step                                                          | `/clear` (fresh context), then paste the step's prompt                                                                  |
| Complex or risky step (schema, RLS, money, sync, payments)                   | Switch to **plan mode** first (press **Shift+Tab** until it shows plan mode), read the plan, correct it, then approve   |
| Context getting full mid-step                                                | Run `/context` to check. Above ~60% full, run `/compact focus on <the current step and files being changed>`            |
| Switching to unrelated work                                                  | `/clear` — never carry old context into a new module                                                                    |
| Claude went the wrong way                                                    | Press **Esc** to interrupt, or `/rewind` to jump back to an earlier checkpoint                                          |
| Coming back tomorrow                                                         | `claude --continue` (last session) or `/resume` (pick a session) — or start fresh; `docs/STATUS.md` holds where you are |
| Big research question ("how do Irish shops reconcile card terminal totals?") | Ask Claude to **use a subagent** for the research so file dumps stay out of your main context                           |
| Before merging anything touching auth, RLS, money, sync or payments          | Run `/security-review`, then ask the `tenant-isolation-auditor` subagent to review                                      |
| End of every step                                                            | Tests green → commit → Claude updates `docs/STATUS.md` → `/clear`                                                       |

**Model choice:** run `/model` and choose **opusplan** (Opus plans, Sonnet executes) as the default. For Phase 1.1 (money), 1.6 (sync), 2.1 (tenders) and 3.6 (security) use Opus for the whole step.

**Never** give Claude Code production database credentials, live API keys, or real customer data.

---

## Part B — Phase 0 · Foundations (weeks 1–2)

Phase 0 is split so **Claude Code does everything it can**, and you only do what needs your identity, payment details, secrets or a browser sign-in.

| Step | Who                               | Time   | What happens                                                                                                  |
| ---- | --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| 0.0  | **You**                           | 1–2 h  | Install 4 tools, create accounts, sign in once in the terminal                                                |
| 0.1  | Claude                            | ~1 h   | Checks your machine, installs missing CLIs, creates the GitHub repo, scaffolds the app, starts local Supabase |
| 0.2  | Claude + you (1 sign-in)          | 20 min | Installs Claude Code plugins and MCP servers; you approve the browser sign-ins                                |
| 0.3  | Claude                            | 30 min | Writes CLAUDE.md, rules, subagents, hooks, skills, status file                                                |
| 0.4  | Claude                            | 2–3 h  | Tenancy schema, RLS, RLS tests; creates and migrates the **staging** Supabase project                         |
| 0.5  | Claude + you (Google keys)        | 3–4 h  | Sign-up, login, MFA, optional Google sign-in                                                                  |
| 0.6  | Claude + you (paste secrets, DNS) | 2–3 h  | CI/CD, branch protection, staging + production deploys, health check                                          |
| 0.6b | Claude                            | 2–3 h  | Own error log, Postgres rate limiter and pg-boss job queue (replaces Sentry, Upstash, Inngest)                |
| 0.7  | Claude                            | 3–4 h  | Design system and app shell                                                                                   |
| 0.8  | Claude                            | 20 min | Verifies the whole phase and writes the exit report                                                           |

**Three rules that apply to every step below**

- **Secrets never go into the chat.** When a key is needed, Claude creates the empty variable and tells you where to paste it: `.env.local`, a `gh secret set` prompt in your own terminal, or your hosting dashboard.
- **Claude only ever touches the staging Supabase project.** You create the production project yourself in the dashboard, and only CI deploys to it.
- **Browser sign-ins are yours.** When Claude needs one, it stops and prints the exact command for you to run in a separate terminal window, then waits for you to type "done".

---

### Step 0.0 — Your checklist (the only manual part)

**Install these four yourself** (they need admin rights, a restart or your login):

- [ ] **Node.js LTS** (22.x) — <https://nodejs.org>
- [ ] **Git** — <https://git-scm.com> (on Windows this also gives you Git Bash, which Claude Code needs)
- [ ] **Docker Desktop** — <https://www.docker.com/products/docker-desktop> (runs Supabase locally; restart after install)
- [ ] **Claude Code** — <https://code.claude.com/docs/en/setup>, then run `claude` once and log in

Optional but recommended: **Python 3.10+** (the security-guidance plugin uses it). Claude can install it for you in Step 0.1 if your OS package manager allows.

Everything else (pnpm, GitHub CLI, Supabase CLI, jq, Vercel CLI) **Claude installs in Step 0.1**.

**Create these accounts** (turn on two-factor authentication on every one):

- [ ] **GitHub**
- [ ] **Supabase** — create an organisation only. Claude creates the staging project for you in Step 0.4. Create the **production** project yourself later (Step 0.6): name `tillflow-prod`, region **West EU (Ireland) eu-west-1**, and save its database password in a password manager.
- [ ] An **SMTP mailbox** for sending email (for now a Gmail account with 2-step verification and an app password; later a tillflow.ie mailbox). No Resend account. (No Sentry, Upstash or Inngest accounts: errors, rate limits and background jobs run on Supabase Postgres — see Step 0.6b.)
- [ ] **Hosting** — decide now and write it down for Step 0.6:
  - `vercel` → create a Vercel account, **or**
  - `hostinger` → make sure your Hostinger Business or Cloud plan has a free **Web Apps (Node.js)** slot and an EU data centre
- [ ] _(Optional)_ **Google Cloud** project if you want "Continue with Google" — Claude gives you the exact clicks in Step 0.5

**Make the project folder:**

1. Create an empty folder called `tillflow-pos`.
2. Inside it, create a `docs` folder and put `TILLFLOW_POS_PLAN.md` in it renamed to `PLAN.md`, and this file renamed to `PROMPTS.md`.
3. Open a terminal in `tillflow-pos` and run `claude`.

---

### Step 0.1 — Machine check, repo and scaffold (Claude)

Session: fresh · plan mode ON (Shift+Tab)

```text
You are setting up the Tillflow POS project from an empty folder. Read docs/PLAN.md fully first (skim docs/PROMPTS.md for context on later steps).

PART 1 — Machine check (report before changing anything)
1. Detect my OS (Windows / macOS / Linux) and shell.
2. Check versions of: node, git, docker (and whether the Docker daemon is running), python3, pnpm, gh, supabase, jq, vercel.
3. Show me a table: tool · installed version · required · action.
4. For every missing tool you CAN install without admin rights or a restart, propose the exact install commands for my OS:
   - pnpm via `corepack enable pnpm` (fallback: npm i -g pnpm)
   - gh, supabase, jq via winget (Windows), Homebrew (macOS) or the official Linux instructions
   - vercel via `pnpm add -g vercel` (only if I later choose Vercel — ask)
   If Node, Git or Docker is missing or Docker isn't running, STOP and tell me exactly what to do.

PART 2 — After I approve, install the missing tools and re-run the version table.

PART 3 — Sign-ins I must do myself. Print these as a checklist, tell me to run each in a SEPARATE terminal window (they open a browser), and wait until I reply "done":
   gh auth login        (choose GitHub.com, HTTPS, login with browser)
   supabase login
Then verify each with: gh auth status · supabase projects list (don't print any keys).

PART 4 — Repo and scaffold
1. git init with main as default branch; create a private GitHub repo with `gh repo create tillflow-pos --private --source . --remote origin`.
2. Scaffold exactly per docs/PLAN.md "Tech stack":
   - Next.js (latest stable, App Router) + TypeScript strict (noUncheckedIndexedAccess on), pnpm
   - Tailwind CSS + shadcn/ui (init; add button, input, dialog, sheet, table, form, sonner, dropdown-menu, tabs, badge, card)
   - ESLint + Prettier, Vitest + Testing Library, Playwright (install browsers)
   - Drizzle ORM + drizzle-kit
   - `supabase init`, then `supabase start` (local Postgres + Auth in Docker)
   - Folders: src/app/(register), src/app/(admin), src/app/(auth), src/app/api/v1, src/lib/money, src/lib/sync, src/lib/auth, src/db/schema, supabase/migrations, tests/{unit,rls,e2e}, docs/specs
3. .env.example listing EVERY variable the plan needs, grouped and commented with where each value comes from (Supabase — including JOBS_DATABASE_URL, a direct/session-mode connection string, NOT the transaction pooler; Resend; ALERT_EMAIL for error alerts; Google OAuth; bank details for invoices; hosting). Do not add Sentry, Upstash or Inngest variables. Create .env.local pre-filled ONLY with the local Supabase values from `supabase status`; leave every cloud key blank. Make sure .env*.local is in .gitignore.
4. package.json scripts: dev, build, start, lint, typecheck, test, test:rls, test:e2e, db:generate, db:migrate, db:reset, verify.
5. Placeholder home page: "Tillflow POS".
6. Run lint + typecheck + test + build; fix anything failing.
7. Commit ("chore: scaffold Tillflow POS") and push to origin main.

Finish with a short report: what was installed, repo URL, and anything that still needs me.
```

**Done when:** the repo is on GitHub, `pnpm dev` shows the page, and `supabase status` shows local services running.
**After:** `/clear`.

---

### Step 0.2 — Claude Code plugins and MCP servers (Claude + 1 sign-in)

Session: fresh

```text
Set up Claude Code tooling for this repo. Use the `claude` CLI from the shell; run `claude plugin install --help` and `claude mcp add --help` first and use the exact flags they show.

1. Plugins from the official marketplace (claude-plugins-official), installed at PROJECT scope so they're recorded in .claude/settings.json:
   security-guidance, code-review, commit-commands, feature-dev, frontend-design,
   plus the official TypeScript language-server (code intelligence) plugin — find its exact name in the marketplace catalog first.
   If the marketplace is missing, add it: anthropics/claude-plugins-official.
2. MCP servers at PROJECT scope (recorded in .mcp.json, which we commit):
   - supabase (HTTP): https://mcp.supabase.com/mcp?read_only=true  — we'll add project_ref=<staging ref> in Step 0.4
3. Confirm Python 3.10+ is available for security-guidance; if not, tell me how to install it for my OS.
4. Tell me to run these two things myself inside this Claude session, then wait for "done":
   /reload-plugins
   /mcp   → sign in to supabase
5. After I say done, list installed plugins and connected MCP servers, and commit .claude/settings.json and .mcp.json.
```

**Done when:** `/plugin` shows the six plugins and `/mcp` shows supabase connected.
**After:** `/clear`.

---

### Step 0.3 — Teach Claude the project: CLAUDE.md, rules, subagents, hooks, skills (Claude)

Session: fresh · plan mode ON

```text
Set up this repo's Claude Code configuration. Read docs/PLAN.md first.

1. CLAUDE.md (project root, under 150 lines): product one-liner; stack; commands (dev, lint, typecheck, test, test:rls, test:e2e, db:*, verify); folder map; these NON-NEGOTIABLE rules:
   - Every business table has org_id, RLS enabled, a policy, and an RLS test in the same PR
   - Money is integer cents; all VAT/rounding goes through src/lib/money — never inline maths
   - Completed sales are never updated; corrections are refunds/voids (new rows)
   - Server recalculates every price and total; never trust client totals
   - Validate every input with Zod; check role in every server action
   - Never log personal data; never hard-code secrets; never ask me to paste secrets into chat; never touch production credentials or the production Supabase project
   - Never execute user-supplied SQL
   - Portability: all auth calls go through src/lib/auth; RLS policies use ONE SQL helper for the current user's orgs; file storage behind src/lib/storage; background jobs in pg-boss (Postgres queue), not Supabase Edge Functions; no Sentry, Upstash or Inngest
   - Done = lint + typecheck + unit + RLS tests pass; update docs/STATUS.md at the end of every task
   Also: "@docs/PLAN.md for full context; @docs/STATUS.md for current progress".

2. Path-scoped rules in .claude/rules/ (with `paths:` frontmatter):
   - db.md for supabase/** and src/db/** (RLS, migrations never edited after merge, UUIDv7, indexes on org_id)
   - money.md for src/lib/money/** (integer cents, half-up rounding, rate snapshot on line, 100% coverage)
   - register-ui.md for src/app/(register)/** (48px targets, solid high-contrast surfaces, WCAG 2.2 AA, offline-first)

3. Subagents in .claude/agents/:
   - tenant-isolation-auditor.md — read-only tools (Read, Grep, Glob); hunts for any way one org can read or write another org's data (RLS gaps, service-role misuse, missing org_id filters, IDOR in route handlers); returns findings with file:line and severity
   - vat-auditor.md — read-only; checks VAT rates, rounding, eat-in/take-away, meal-deal apportionment against docs/PLAN.md section 12
   - accessibility-reviewer.md — read-only; reviews UI files against WCAG 2.2 AA and the register rules

4. Hooks in .claude/settings.json (merge with what's there; keep the plugin entries):
   - PostToolUse on Edit|Write: format the changed file with Prettier (read the path from the hook's stdin JSON with jq: `.tool_input.file_path`)
   - PreToolUse on Edit|Write: block (exit 2 with a message) edits to .env* files, and to any file in supabase/migrations/ that is already committed to main — write the check as .claude/hooks/protect-files.sh (plus a .ps1 twin if I'm on Windows without Git Bash)
   - SessionStart with matcher "compact": print docs/STATUS.md so progress survives compaction

5. Project skills in .claude/skills/:
   - new-table/SKILL.md — recipe to add a table: Drizzle schema → migration → RLS policies → RLS test (Shop A vs Shop B) → types
   - write-spec/SKILL.md — turns a feature request into docs/specs/<feature>.md with screens, data, rules, edge cases and acceptance tests; set `disable-model-invocation: true` so it only runs when I type /write-spec

6. .claude/claude-security-guidance.md for the security-guidance plugin: multi-tenant rules (org_id on every query, never service-role in user-facing routes), money rules, PIN/device rules.

7. docs/STATUS.md: current phase/step, done list, next step, open issues. Mark Steps 0.0–0.2 done.

8. Test the protect hook by attempting a harmless edit to .env.example and confirm it's blocked, then commit everything.
```

**Done when:** `/memory` shows CLAUDE.md, `/agents` lists the three subagents, `/hooks` shows the three hooks, and the `.env` edit was blocked.
**After:** `/clear`.

---

### Step 0.4 — Core schema, tenancy, RLS and the staging project (Claude)

Session: fresh · plan mode ON · Opus

```text
Use the new-table skill. Read docs/PLAN.md sections 8 and 10.

PART 1 — Local first
Create the tenancy foundation:
- organisations (business_type enum: general, electronics, clothing, cafe, restaurant; country default 'IE'; plan; trial_ends_at; status)
- locations, memberships (role enum owner|manager|cashier, pin_hash nullable, location_ids), registers
- tax_rates (country, code, rate_bp, valid_from, valid_to) seeded with Irish rates incl. the 1 July 2026 change: food/catering & hairdressing 13.5% → 9%
- audit_log (append-only: revoke UPDATE/DELETE)
- ONE SQL helper returning the caller's org ids from memberships, used by every policy
RLS on every table. Tests in tests/rls with two orgs (Shop A, Shop B) and three roles proving: A cannot select/insert/update/delete B's rows; cashier cannot change roles; nobody can update audit_log.
Add `pnpm test:rls` and a check (scripts/check-rls.ts) that fails if any public table lacks RLS. Run everything against local Supabase until green.

PART 2 — Create the STAGING project (ask me before running)
1. `supabase orgs list` → confirm the org with me.
2. Create the project with the Supabase CLI: name tillflow-staging, region eu-west-1. Generate a strong database password in the shell and write it ONLY to .env.local as SUPABASE_STAGING_DB_PASSWORD — never print it or show it to me in chat.
3. `supabase link` to the staging project, then `supabase db push` to apply migrations. Run check-rls against staging (read-only query).
4. Update .mcp.json so the supabase MCP URL includes project_ref=<staging ref>&read_only=true. Tell me to run /mcp to reconnect.
5. Write the staging URL and anon key into .env.local (they're not secret-critical, but still don't print the service-role key).
Never create, link or push to a production project.

Commit, and update docs/STATUS.md.
```

**Done when:** `pnpm test:rls` is green locally, staging has the same schema, and the RLS check passes on staging.
**After:** say "Use the tenant-isolation-auditor subagent to review this branch." → fix findings → `/security-review` → commit → `/clear`.

---

### Step 0.5 — Auth, sign-up, MFA and Google sign-in (Claude + you for Google keys)

Session: fresh · plan mode ON

```text
Implement authentication with Supabase Auth per docs/PLAN.md section 10. All auth calls go through src/lib/auth.
- Sign up (email + password), log in, magic link, password reset, email verification
- TOTP MFA required for owners before accessing the back office
- On first sign-up create organisation + owner membership in one transaction
- Middleware protecting (admin) routes; `requireRole('owner'|'manager')` used in server actions
- Rate-limit login (5/min per IP+email) and password reset (3/hour per email) with a small Postgres-backed limiter in src/lib/rate-limit: a `rate_limits` table plus an atomic `check_rate_limit()` SQL function (fixed window, keys stored as SHA-256 hashes, executable by the service role only). No Redis. Test it with 20 parallel calls against a limit of 5: exactly 5 must be allowed
- "Continue with Google" for owners and managers only (never for cashier PIN unlock):
  1. Configure the Google provider in supabase/config.toml for local dev, reading the client id/secret from env vars.
  2. Give me a numbered click-by-click guide to create the OAuth client in Google Cloud Console (consent screen, authorised redirect URIs for local, staging and production), and tell me which env var names to paste the values into (.env.local) and where to enter them in the Supabase staging dashboard. Wait for me to say "done" — never ask me to paste them into chat.
  If I say "skip Google", leave the button behind a feature flag that's off.
- Route new orgs to an /onboarding placeholder.
- Playwright e2e: sign up → MFA enrol → empty dashboard; wrong-org access returns 404.
```

**Done when:** e2e tests pass locally; Google sign-in works on localhost (or is flagged off).
**After:** `/security-review` → commit → `/clear`.

---

### Step 0.6 — CI/CD, environments, hosting and monitoring (Claude + you for secrets and DNS)

Before starting, fill in your hosting choice from Step 0.0 in the first line of the prompt.

Session: fresh · plan mode ON

```text
HOSTING = hostinger

Set up delivery. Read docs/PLAN.md sections 6, 10 and 11.

1. GitHub Actions (write the workflows):
   - ci.yml on every PR: install, lint, typecheck, unit, RLS tests against a local Supabase started in the runner, build, Playwright against a local production build
   - migrate-staging.yml on merge to main: supabase db push to STAGING
   - promote-production.yml: manual trigger with a required approval (GitHub environment "production") that pushes migrations to PRODUCTION
2. Use `gh` to automate GitHub settings:
   - create environments "staging" and "production" (production requires my approval as reviewer)
   - branch protection on main: require CI to pass and a PR (no direct pushes)
   - enable Dependabot (npm + GitHub Actions) via .github/dependabot.yml and turn on secret scanning if available on my plan
3. Secrets: list every GitHub secret each workflow needs. For each, print the exact command for ME to run in my own terminal, e.g. `gh secret set SUPABASE_ACCESS_TOKEN --env staging` (it prompts me for the value). Wait for "done", then verify with `gh secret list` (names only).
4. Production Supabase: tell me to create tillflow-prod myself in the dashboard (region eu-west-1, strong password saved in my password manager) and add its values only as GitHub "production" environment secrets. You must never see or use them.
5. Hosting:
   - If HOSTING = vercel: install/verify the Vercel CLI, `vercel link`, set region dub1 in vercel.json, connect the GitHub repo so every PR gets a preview. For env vars, print `vercel env add <NAME> <environment>` commands for me to run (they prompt for the value). Staging = preview, production = main.
   - If HOSTING = hostinger: there's no CLI, so write docs/DEPLOY-HOSTINGER.md with click-by-click hPanel steps for TWO Web Apps: staging.tillflow.ie (branch develop) and pos.tillflow.ie (branch main) — GitHub connection, Node version, build command, start command, output mode, and the env var names to paste. Set Next.js `output: 'standalone'` if Hostinger needs it, create the develop branch, and adjust ci.yml so staging deploys from develop.
6. DNS: list the exact records I must add in Hostinger hPanel (pos. and staging. (email goes out over SMTP, so no sending-domain records for now)) in a table I can copy.
7. Monitoring: create /api/health returning JSON with `"status":"ok"`, version and commit (it must check the database), and give me the Better Stack uptime-monitor settings to click in. Do NOT add Sentry — error logging is built in Step 0.6b.
8. Write docs/DEPLOY.md explaining every environment in plain English.
9. Push a small test PR and confirm with `gh pr checks` that CI passes; after I've done the hosting steps, confirm staging /api/health returns 200.
```

Optional: run `/install-github-app` so you can mention `@claude` on PRs and issues (see <https://code.claude.com/docs/en/github-actions>).

**Done when:** CI passes on a PR, staging answers `/api/health`, and branch protection blocks direct pushes to main.
**After:** commit → `/clear` → run Step 0.6b.

---

### Step 0.6a — Course change (use this INSTEAD of 0.6b if you are already partway through 0.6)

Session: your current 0.6 session · plan mode ON

Paste this as one message. It tells Claude where you are and what changed, so you can carry on without starting over.

```text
COURSE CHANGE — please read fully before doing anything, and show me your plan first (don't edit yet).

WHERE WE ARE: Step 0.6 is mostly built. CI/CD workflows, branch protection, the health check and the Hostinger deploy docs exist. The 0.6 entry for docs/STATUS.md is still waiting to go to develop through a main → develop PR. I have NOT created any Upstash, Sentry or Inngest accounts, and I have NOT created the Hostinger staging app yet.

DECISION: I no longer want Sentry, Upstash or Inngest. Their free tiers won't cope with production, and each one adds a sub-processor and secrets. Replace them with things that run on our Supabase Postgres:
1. Errors → our own logging: pino, an `error_events` table (fingerprint grouping, count, first/last seen, status new|resolved|ignored), an allow-list PII scrubber, instrumentation.ts `onRequestError`, a same-origin size-limited POST /api/log-error for browser errors, email alerts to ALERT_EMAIL via Resend (new fingerprint only, max 1 email per fingerprint per hour, plus a daily digest), 90-day prune. It must never throw. RLS on, no client access.
2. Rate limits → a `rate_limits` table plus an atomic `check_rate_limit()` SQL function (INSERT … ON CONFLICT, service_role only, keys stored as SHA-256 hashes) behind src/lib/rate-limit. An in-memory limiter for /api/v1/sync/* and /api/log-error. Fail closed on auth routes, open elsewhere. PIN lockout stays as DB counters, not this limiter. Test: 20 parallel calls against a limit of 5 must allow exactly 5.
3. Background jobs → pg-boss in src/lib/jobs, connected with JOBS_DATABASE_URL (direct/session connection, NOT the port-6543 transaction pooler). Do not let it migrate at runtime: generate its schema SQL into a Supabase migration and start it with migrate/createSchema off. Worker starts from instrumentation.ts when NEXT_RUNTIME is nodejs and JOBS_ENABLED isn't false. Register scheduled jobs for rate_limits cleanup, the error digest and the error prune.
4. /api/health keeps `"status":"ok"` (app + database) and adds `"jobs":"ok"|"down"` from a worker heartbeat.

WHAT TO DO:
a) Find everything Sentry/Upstash/Inngest in the repo (code, next.config, CI workflows, docs/DEPLOY.md, docs/DEPLOY-HOSTINGER.md, docs/specs/auth.md, package.json) and tell me what you find. Remove it. At the end a grep for sentry|upstash|inngest must return nothing except one note in docs/DEPLOY.md explaining why they were dropped.
b) Build the replacements above, with tests. Migration numbers continue after the existing ones (0004 and 0005 are already written for staging).
c) Check Hostinger's docs on whether a Web Apps (Node.js) app stays running or can sleep/restart. pg-boss needs a running process. Put the answer in docs/DEPLOY.md. If it can sleep, STOP and tell me.
d) You can't edit .env.example. Give me the exact lines to add and remove by hand instead. Remove SENTRY_*, UPSTASH_*, INNGEST_*. Add NEXT_PUBLIC_APP_ENV=development, JOBS_DATABASE_URL=, ALERT_EMAIL=.
e) Update the env var table in docs/DEPLOY-HOSTINGER.md (remove the three services, add JOBS_DATABASE_URL and ALERT_EMAIL). In docs/DEPLOY.md add a second Better Stack monitor on /api/health with keyword `"jobs":"ok"` and a short "Where do errors go?" section. Add a 0.6 entry to docs/STATUS.md that mentions this change.
f) Do NOT touch the uncommitted docs/PROMPTS.md edit. It isn't yours.

ORDER OF WORK (this replaces the old remaining-steps list):
1. Sync develop first: a main → develop PR. I'll click Squash and merge once CI is green.
2. Then branch off develop for all of the above and open a PR to develop. Staging deploys from develop, so this must be merged BEFORE I create the Hostinger app.
3. Me: set staging Supabase auth URLs (Site URL https://staging.tillflow.ie, redirect https://staging.tillflow.ie/auth/callback), then create the Hostinger staging app from section A of docs/DEPLOY-HOSTINGER.md, add the DNS record, wait for SSL, turn on Force HTTPS, and set the GitHub variable STAGING_URL.
4. You: run migrate-staging as a dry run first, then for real (0004, 0005 and the new migrations).
5. You: verify staging /api/health returns 200 with the right commit and jobs "ok".
6. Me: two Better Stack monitors, then trigger a test error on staging and confirm it lands in error_events and the alert email contains no name or email address.
7. Later, production: create tillflow-prod, set the production GitHub secrets myself (you only check the names), promote-production with my approval, the Hostinger production app, Better Stack for production, then Resend DNS for tillflow.ie. Production needs no Upstash or Sentry.

RULES: I never paste secrets into chat; give me commands to run myself and wait for "done". Steps marked "Me" are mine; tell me when it's my turn. Don't touch production credentials.

Start by listing every Sentry/Upstash/Inngest reference you find and your plan for the change. Then wait for my "go".
```

**Done when:** you've approved the plan, the change is merged into develop, and `/api/health` on staging shows both `"status":"ok"` and `"jobs":"ok"`. Mark 0.6 done at that point.

---

### Step 0.6b — Replace Sentry, Upstash and Inngest with in-house versions (Claude)

Session: fresh · plan mode ON

Run this straight after Step 0.6 (if you are already partway through 0.6, use Step 0.6a above instead). If Sentry, Upstash or Inngest were already added, this step removes them. If they weren't, it builds the replacements directly.

```text
Read docs/PLAN.md sections 6, 10 and 11 and docs/STATUS.md. We are NOT using Sentry, Upstash or Inngest (free-tier limits, extra sub-processors). Errors, rate limits and background jobs run on our Supabase Postgres. Work on a branch off develop and open a PR to develop.

1. REMOVE anything already installed: @sentry/nextjs, @upstash/ratelimit, @upstash/redis, inngest. Delete sentry.*.config.ts, the withSentryConfig wrapper in next.config, /api/inngest, and every SENTRY_*, UPSTASH_* and INNGEST_* reference in code, .env.example, CI workflows, docs/DEPLOY.md, docs/DEPLOY-HOSTINGER.md and docs/specs/auth.md. Keep NEXT_PUBLIC_APP_ENV. Grep the whole repo for "sentry", "upstash" and "inngest" at the end — nothing may remain except a note in docs/DEPLOY.md saying why they were dropped.

2. ERROR LOGGING (src/lib/errors, server-only):
   - logger.ts: pino, JSON to stdout, level from env, redacts cookies, authorization headers, request bodies and any field named email/name/phone/password/token/pin.
   - scrub.ts: ALLOW-LIST scrubbing. Keep only: error name, message (with emails, phone numbers, long digit runs and tokens masked), stack, route, HTTP method, status, environment, commit, org_id and user_id (UUIDs only). Drop everything else.
   - capture.ts: captureError(error, context). Compute a fingerprint = sha256(name + normalised message + top 3 stack frames without line numbers). Upsert into `error_events` (new migration: id, fingerprint, env, first_seen, last_seen, count, message, stack, context jsonb, status new|resolved|ignored; unique (fingerprint, env)). It must NEVER throw: on any failure, fall back to logger.error.
   - RLS on error_events: no client access. Add an explicit policy so our "every table has a policy" CI check passes, e.g. select only for super-admins; writes only through the service role.
   - instrumentation.ts: export register() and onRequestError() so server errors in route handlers, server actions and server components are captured.
   - Browser errors: error.tsx / global-error.tsx plus window "error" and "unhandledrejection" listeners POST to /api/log-error. That endpoint is same-origin only, max 8 KB body, Zod-validated, in-memory rate-limited (30/min per IP), and scrubbed with the same function.
   - Alerts (SMTP via nodemailer): email ALERT_EMAIL when a fingerprint is first seen, or seen again after being marked resolved; at most one email per fingerprint per hour. Add a daily digest email (new + top recurring errors) as a scheduled pg-boss job. Prune events older than 90 days.
   - No source-map upload. Keep productionBrowserSourceMaps off, but save each build's source maps as a private CI artifact named by commit so I can de-minify a browser stack by hand.

3. RATE LIMITING (src/lib/rate-limit):
   - New migration: `rate_limits (key text, window_start timestamptz, count int, primary key (key, window_start))` and `check_rate_limit(p_key text, p_limit int, p_window_seconds int)` returning allowed, remaining, retry_after. Use INSERT … ON CONFLICT DO UPDATE so it is atomic under concurrency. SECURITY DEFINER, REVOKE from anon/authenticated, GRANT to service_role only. RLS on with a deny-all policy.
   - Keys are SHA-256 hashes of IP and/or email — never raw personal data in the table.
   - rateLimit({ name, key, limit, windowSec }) wrapper. Policies: login 5/min per IP+email; reset 3/hour per email and 10/hour per IP; exports 5/hour per user; imports 5/hour per org. Cashier PIN lockout (5 failures → 15 min) is NOT this limiter — keep it as counters on the device/cashier rows in the database.
   - A separate in-memory limiter (memoryRateLimit) for /api/v1/sync/* and /api/log-error, where a database write per request isn't worth it. Use generous limits, and say in a comment that it is per-process.
   - If the database call fails: fail CLOSED for auth routes, fail OPEN for everything else, and log it.
   - Test: 20 parallel calls with limit 5 → exactly 5 allowed; window rollover; two keys don't interfere.

4. BACKGROUND JOBS (src/lib/jobs) with pg-boss:
   - Install pg-boss and check the installed version's docs. Connect with JOBS_DATABASE_URL (direct or session-mode connection — NOT the transaction pooler on port 6543). Add it to .env.example (blank) and the staging/production env tables in docs/DEPLOY-HOSTINGER.md.
   - Our rule is "migrations only via CI", so do NOT let pg-boss migrate itself at runtime. Generate its schema SQL with the library's construction-plan helper into a Supabase migration, and start it with migrate/createSchema disabled. Confirm the pgboss schema is not exposed through the Supabase API, and make our RLS-coverage CI check look at the public schema only.
   - boss.ts singleton; worker started from instrumentation.ts only when NEXT_RUNTIME === 'nodejs' and JOBS_ENABLED !== 'false'. Handlers in src/lib/jobs/handlers/*: Zod-validated payload with org_id, idempotent, retries with backoff, service-role access only. enqueue() helper.
   - Register these scheduled jobs now: rate_limits cleanup (hourly, delete rows older than 1 day), error digest (daily), error_events prune (daily). Later steps (import, reports, exports, billing) will add their own handlers.
   - /api/health keeps `"status":"ok"` meaning app + database are fine, and adds `"jobs":"ok"` or `"jobs":"down"` based on a worker heartbeat (a row or pg-boss state updated at least every minute).
   - Test: a job enqueued in a test is processed once; a failing job retries then lands in failed state; two workers never run the same job twice.

5. HOSTING CHECK: pg-boss needs a Node process that stays running. Find out from Hostinger's docs whether a Web Apps (Node.js) app is kept alive continuously or can sleep/restart. Write what you find in docs/DEPLOY.md. If it can sleep, STOP and tell me — don't invent a workaround.

6. DOCS: update docs/DEPLOY.md, docs/DEPLOY-HOSTINGER.md, docs/specs/auth.md and docs/STATUS.md (add a "0.6b" entry). In docs/DEPLOY.md add a second Better Stack monitor on /api/health with keyword `"jobs":"ok"`, and a "Where do errors go?" section: the error_events table, how to read it with the Supabase MCP or dashboard, how alerts work, and how to mark an error resolved.

7. Run lint + typecheck + unit + RLS tests + build. Push the branch and open a PR to develop. Show me: the list of removed packages, the new migration file names, and the exact env vars I need to add in Hostinger (names only).
```

**Done when:** the repo has no Sentry/Upstash/Inngest references, CI is green, the RLS tests pass with the new tables, and after you merge to develop and staging redeploys, `/api/health` shows `"status":"ok"` and `"jobs":"ok"`.
**You do:** add `JOBS_DATABASE_URL` and `ALERT_EMAIL` to the Hostinger staging app; add the second Better Stack monitor; on staging, trigger a test error and confirm it appears in `error_events` and you get an email with no name or email address in it.
**After:** `/security-review` → commit → `/clear`.

---

### Step 0.7 — Design system and app shell (Claude)

Session: fresh · plan mode ON

```text
Using the frontend-design plugin's guidance, create the Tillflow design system and app shell per docs/PLAN.md section 13:
- Design tokens (CSS variables) for colour, type scale, spacing, radius; light + dark
- Two surface styles: "glass" (translucent, back office cards and marketing only) and "solid" (register — high contrast, no translucency)
- Back-office layout: left nav (Dashboard, Sales, Products, Inventory, Customers, Staff, Reports, Settings), top bar with user menu, responsive to tablet
- Register layout skeleton: two panes (tiles/search left, cart + Pay right), status pill (Online/Offline/Syncing), landscape 1024×768 minimum
- All strings via a simple i18n helper (en-IE now; ga-IE later)
- A /design page showing every component and token for review
Then use the accessibility-reviewer subagent to check contrast and focus states, and fix what it finds.
Take Playwright screenshots of /design and the two layouts at 1024×768 and 390×844, save them to docs/screenshots/, and tell me where to look.
```

**After:** review the screenshots and the staging preview on a real tablet → commit → `/clear`.

---

### Step 0.8 — Phase 0 verification (Claude)

Session: fresh

```text
Verify Phase 0 is complete. Create scripts/verify-phase0.ts (wired to `pnpm verify`) that checks and prints PASS/FAIL with evidence for:
- required tools and versions installed
- every variable in .env.example is present in .env.local (names only — never print values)
- lint, typecheck, unit, RLS tests and the no-table-without-RLS check pass
- latest CI run on main is green (`gh run list`)
- branch protection on main is enabled (`gh api`)
- GitHub secrets exist for staging and production (names only)
- staging /api/health returns 200 with the current commit
- Claude Code: plugins installed, MCP servers configured, hooks registered, three subagents present
Run it, fix anything Claude can fix, and list anything that needs me.
Then update docs/STATUS.md: Phase 0 complete (or what's left), and next step = Phase 1 Step 1.1.
```

**Phase 0 exit gate:** `pnpm verify` is all PASS, the design system is approved, and `docs/STATUS.md` says Phase 0 is complete.

---

## Part C — Phase 1 · Core register (weeks 3–7)

### Step 1.1 — Money & VAT library

Session: `/clear` · plan mode ON · **Opus**

```text
/write-spec VAT and money library for Irish POS — then implement it.

Requirements (docs/PLAN.md sections 8 & 12):
- src/lib/money: integer-cent Money type; VAT-inclusive prices; per-line VAT = price − price/(1+rate), rounded half-up to the cent; totals = sum of lines
- Effective-dated rate lookup by (country, tax_category, date) — a sale on 30 June 2026 vs 1 July 2026 must differ for catering
- Tax categories: standard_23, reduced_13_5, second_reduced_9, zero, livestock_4_8
- Eat-in vs take-away switch that maps a product to a different category
- Meal-deal apportionment across rates (proportional to standalone prices)
- Discounts (line and basket) applied before VAT split
- 5c cash rounding (only for cash tender), shown as a separate rounding line
- Deposit (Re-turn) and bag levy as non-VAT line types
Write exhaustive Vitest tests (table-driven), target 100% coverage of src/lib/money. No UI.
```

After: ask **"Use the vat-auditor subagent to review src/lib/money against the plan."** → commit → `/clear`.

### Step 1.2 — Onboarding and business-type presets

Session: `/clear` · plan mode ON

```text
Implement onboarding and business types per docs/PLAN.md section 4.
- /onboarding wizard (4 steps): business name + VAT number (validate Irish VAT format) → business type (5 large illustrated cards) → number of tills → "import products now or start empty"
- src/config/business-type-presets.ts: for each type, the product fields enabled, register options, starter categories (seeded), dashboard tiles, receipt options
- Settings → Business type page to change type later (only toggles presets; never deletes data)
- Zod schema for variant `attributes` per type (IMEI/serial + warranty for electronics; size/colour for clothing; modifiers + allergens for cafe/restaurant; age_restricted + deposit for general)
- Unit tests for presets; Playwright: each type completes onboarding and lands on a dashboard with the right starter categories
```

After: commit → `/clear`.

### Step 1.3 — Products, variants, categories

Session: `/clear` · plan mode ON

```text
Use the new-table skill for: categories, products, variants (with attributes JSONB), stock_levels, stock_movements (append-only), modifier_groups, modifiers, product_modifier_groups.
Back office screens: product list (search, filter by category, paginated), product editor that shows only the fields enabled for the org's business type, variant matrix builder for clothing (size × colour), modifier group editor for cafe/restaurant, allergen picker (14 EU allergens), barcode field with uniqueness per org.
Price entry is VAT-inclusive; show the ex-VAT and VAT amount live using src/lib/money.
RLS tests for every new table; Playwright for create/edit product per business type.
```

After: commit → `/clear`.

### Step 1.4 — Register screen (retail flow)

Session: `/clear` · plan mode ON

```text
Build the register at src/app/(register) per docs/PLAN.md sections 9 and 13 and .claude/rules/register-ui.md.
- Category tiles + product grid + search; barcode scanner input (keyboard-wedge listener that works anywhere on screen)
- Cart: qty, line discount, basket discount, remove, park/recall sale
- Business-type behaviour from presets: serial prompt (electronics), variant picker (clothing), age-check prompt (general), modifier picker (cafe)
- Totals always visible; tabular numerals; 48px targets; solid surfaces
- Tender screen stub (cash only for now)
- The register reads catalogue ONLY from IndexedDB (Dexie) — build the local catalogue cache + background refresh ("changes since cursor" endpoint)
Playwright: complete a 3-item sale in 3 taps + tender on a 1024×768 viewport.
```

After: ask the **accessibility-reviewer** subagent → commit → `/clear`.

### Step 1.5 — Cash sales, receipts and printing

Session: `/clear` · plan mode ON

```text
Implement cash tender and receipts:
- Cash tender with quick-cash buttons, change due, 5c rounding line (from src/lib/money)
- Sequential receipt numbers per register
- Receipt layout: business legal name, VAT number, address, date/time, lines, VAT summary by rate, payment, rounding, receipt footer, warranty dates (electronics)
- Printing: ESC/POS via WebUSB for USB thermal printers + network printers via a tiny local print bridge (document it); browser print fallback; cash drawer kick on cash sales
- Email receipt via SMTP (nodemailer)
- "Convert to VAT invoice" for B2B customers (adds customer VAT number)
Write unit tests for receipt data and a Playwright test using the browser-print fallback.
```

After: commit → `/clear`.

### Step 1.6 — Offline outbox and sync

Session: `/clear` · plan mode ON · **Opus**

```text
/write-spec offline sale sync — then implement it exactly per docs/PLAN.md section 9.
- Dexie outbox: every completed sale written locally first with UUIDv7 + idempotency key; receipt prints before any network call
- Background sync (service worker via Serwist + in-page fallback): posts in order to POST /api/v1/sync/sales, exponential backoff, never deletes an outbox row until the server confirms
- Server: authenticate device token, validate with Zod, RECALCULATE totals and VAT with src/lib/money, reject mismatches > 1c, write sale + lines + payments + stock_movements in one transaction, idempotent on replay
- Rejected sales go to a "Needs attention" list for managers — never silently dropped
- Status pill Online / Offline (n waiting) / Syncing; warning after 24h offline
Playwright tests: go offline → make 20 sales → reload the page → reconnect → exactly 20 sales on server, stock correct; duplicate replay creates nothing.
```

Mid-step: this step is long. When `/context` shows it's filling, run:
`/compact focus on the sync protocol, outbox schema, the server endpoint and failing tests`
After: `/security-review` → **tenant-isolation-auditor** subagent → commit → `/clear`.

### Step 1.7 — Device pairing and cashier PINs

Session: `/clear` · plan mode ON · Opus

```text
Implement register pairing and staff PINs per docs/PLAN.md section 10:
- Manager creates a register in the back office → one-time 8-character pairing code (10-minute expiry)
- Device enters code → receives a device token (store only its hash server-side); revoke from back office
- Cashier unlock: 4–6 digit PIN, Argon2 hash, 5 failures → 15-minute lockout, rate-limited; PIN never works on an unpaired device
- Manager override prompt for refunds, discounts above a threshold, no-sale drawer opens — all written to audit_log
Tests for pairing expiry, revoke, lockout, override logging.
```

After: `/security-review` → commit → `/clear`.

**Phase 1 exit gate:** a cash sale made offline syncs with correct VAT for every business type. Update `docs/STATUS.md`.

---

## Part D — Phase 2 · Payments, hospitality & daily operations (weeks 8–14)

### Step 2.1 — Tenders: card (external terminal), split tender and vouchers

Session: `/clear` · plan mode ON · **Opus**

```text
v1 has NO integrated card reader and NO Stripe. Shops take card payments on their own standalone terminal; Tillflow only records the tender. Read docs/PLAN.md sections 8, 9 and 10.
Implement the tender screen on top of the cash flow from Step 1.5:
- Tender types: cash, card (external terminal), voucher; configurable list per location (e.g. "Card – AIB terminal", "Card – SumUp")
- Card tender defaults to the exact amount due; the cashier confirms after the shop's terminal approves; optional field for the terminal receipt/approval reference (validate: never accept anything that looks like a full card number — reject 13–19 digit strings)
- Split tender: any mix of cash, card and voucher until the balance is 0; change only ever given from cash
- Tips on card (hospitality types): entered by the cashier, stored separately from the sale total
- Void a tender before the sale completes; after completion only refunds (Step 2.2)
- All tenders work fully offline and sync through the existing outbox; the server recalculates that tenders sum to the sale total
- Z-report groundwork: totals per tender type, so the owner can compare the card total with their terminal's end-of-day report
Tests: split tender combinations, change maths, card-number rejection, offline card sale syncs correctly.
```

After: `/security-review` → commit → `/clear`.

### Step 2.2 — Refunds, voids and exchanges

```text
Implement refunds/voids/exchanges per docs/PLAN.md: find receipt (scan, number, or serial/IMEI for electronics), select lines, reason required, manager override above threshold, refund to original tender (card refunds are done on the shop's own terminal; Tillflow records them as a card refund tender), exchanges for clothing, stock movements reversed, VAT reversed at the ORIGINAL line rate. Never edit the original sale. Tests for partial refund VAT maths.
```

Session: `/clear` · plan mode ON · After: commit → `/clear`.

### Step 2.3 — Shifts, cash management, X/Z reports

```text
Implement shifts per docs/PLAN.md: open shift with float, cash in/out with notes, X-report (mid-shift) and Z-report (close) showing sales by tender, VAT by rate, refunds, discounts, tips, expected vs counted cash and over/short. Z-report printable and emailed to the owner. Z closes are immutable. Tests for over/short maths.
```

Session: `/clear` · plan mode ON · After: commit → `/clear`.

### Step 2.4 — Inventory screens and stock ledger

```text
Build inventory: stock levels per location, adjustments with reasons (damage, count, received), movement history per variant, low-stock alerts and threshold per product, stock valuation (cost × on hand). All changes go through stock_movements; stock_levels updated in the same transaction. Negative stock allowed but highlighted.
```

Session: `/clear` · After: commit → `/clear`.

### Step 2.5 — Customers

```text
Customers module: create/search at the register and in back office, purchase history, B2B VAT number, marketing consent with timestamp, GDPR export and delete (anonymise sales links). Customer data export/delete requires owner/manager and is audit-logged.
```

Session: `/clear` · After: `/security-review` → commit → `/clear`.

### Step 2.6 — Café flow: modifiers, allergens, eat-in/take-away, tickets

Session: `/clear` · plan mode ON

```text
Build the café register flow per docs/PLAN.md section 4 (business_type = cafe):
- Modifier picker (required/optional groups, min/max, price deltas) on tap
- Allergen badges on tiles and in the cart; allergen list printable
- Eat-in / take-away toggle on the order that switches VAT categories via src/lib/money (tea/coffee 9%, soft drinks 23%, cold take-away food 0% etc.)
- Order name/number; bar/kitchen ticket printing routed by category to printers
- Tips on card tenders (entered by the cashier)
Playwright: a café order with 2 modified coffees + a take-away sandwich produces correct VAT by rate.
Ask the vat-auditor subagent to review before finishing.
```

After: commit → `/clear`.

### Step 2.7 — Restaurant flow: tables, tabs, courses, split bills

Session: `/clear` · plan mode ON

```text
Build the restaurant flow (business_type = restaurant), reusing the café modifiers/allergens/tickets:
- Floor plan editor (drag tables, seats) in back office; table map on the register with status (free, seated, ordered, bill requested)
- Open tab per table; add items by seat and course; "send" fires kitchen tickets by course; "fire next course"
- Split bill by item, by seat, or evenly; each part paid by cash/card; service charge (configurable, clearly shown) and tips
- Transfer tab between tables; merge tables
- Tabs survive offline and sync like sales (reuse the outbox pattern)
Playwright: table of 4, two courses, split by seat, one pays card with tip, one cash.
```

Mid-step: `/compact focus on the tab/table data model and the split-bill logic` when context fills.
After: commit → `/clear`.

### Step 2.8 — Bulk import

Session: `/clear` · plan mode ON

```text
Implement bulk import per docs/PLAN.md section 5:
- Upload .xlsx/.csv/.json (≤ 50,000 rows); per-business-type downloadable templates
- Column mapping UI with auto-match and saved mappings; presets for Square, Lightspeed, Imonggo, Shopify exports
- Validation preview with row-level errors and a downloadable error file
- Create-only vs create-and-update (match on SKU/barcode)
- pg-boss background job in batches with progress; import_jobs table; undo within 24 hours by batch_id
- Server-side parsing only (Papa Parse, ExcelJS); file size/type limits; files deleted after 7 days
- NEVER accept or execute .sql files — show a friendly message explaining how to export to CSV
Tests: 10k-row file, bad rows, duplicate barcodes, undo.
```

After: `/security-review` → commit → `/clear`.

### Step 2.9 — Reports and filtered exports

Session: `/clear` · plan mode ON

```text
Build reports: dashboard (today vs same day last week, top products, low stock), sales by day/product/category/staff/hour, VAT by rate and period (for VAT3), payments by tender, tips, covers & spend per cover (restaurant), serials sold (electronics), sales by size/colour (clothing).
- Pre-aggregate into daily_sales_summary via a scheduled pg-boss job; dashboards never scan raw sales
- Every list/report has an Export button: exactly what's filtered on screen → .xlsx (ExcelJS), .csv, .pdf (react-pdf); large exports run in the background and email a signed link
- Escape cells starting with = + - @ (formula injection)
- Full-account ZIP export for owners (GDPR portability)
- Exports with customer data: owner/manager only, rate-limited, audit-logged
```

After: ask the **vat-auditor** subagent to review the VAT report → commit → `/clear`.

**Phase 2 exit gate:** in staging, run one full trading day for each of the 5 business types (open shift → sales → refunds → Z-report → exports) with correct numbers. Update `docs/STATUS.md`.

---

## Part E — Phase 3 · SaaS readiness (weeks 15–17)

### Step 3.1 — Bank-transfer billing

```text
Implement subscription billing per docs/PLAN.md section 14. There is ONE fixed monthly price (no tiers) and shops pay by BANK TRANSFER.

1. Config: PRICE_CENTS, TRIAL_DAYS, GRACE_DAYS, INVOICE_DUE_DAYS and our bank details (account name, IBAN, BIC) come from env/settings — never hard-coded. There is NO Stripe or other payment provider in v1.
2. Use the new-table skill for billing_invoices (sequential invoice_no with no gaps, org_id, amount_ex_vat, vat_rate, vat, total, issued_at, due_at, payment_reference, paid_at, bank_reference, marked_paid_by) and extend subscriptions (status trial|active|overdue|paused, price_cents, period_start, period_end).
3. Payment reference: short, unique, human-typeable (e.g. TF-7K3Q-0925) with a check character so typos are caught when matching.
4. pg-boss jobs (scheduled + idempotent): at trial end and each period start, generate the invoice, render it as a PDF (our VAT number, sequential number, VAT rate and amount, IBAN/BIC, payment reference) and email it; reminders at due date and due + 7 days; after GRACE_DAYS unpaid → status paused = read-only (can view and export, can't make sales); never delete data.
5. Owner-facing Billing page: current status, next invoice date, invoice history with PDF downloads, our bank details and the payment reference with a copy button.
6. Super-admin (only): invoices list filtered by status (outstanding, overdue, paid); "Mark as paid" requires the bank reference and date; "Unpause"; optional CSV upload of a bank statement that suggests matches by payment reference (a human still confirms each). Every action audit-logged.
7. Keep billing behind a small interface (src/lib/billing) so an automated provider can be added in v2 without touching the rest of the app — but don't build or install any provider now.
8. Tests: invoice numbering has no gaps under concurrency; VAT maths; reminders and pause timing (fake timers); read-only mode blocks sales but allows exports; only super-admin can mark paid.
```

Session: `/clear` · plan mode ON · After: `/security-review` → commit → `/clear`.

### Step 3.2 — Super-admin panel

```text
Build /superadmin for my account only (separate role, MFA required, IP allowlist env var): list organisations with billing status/trial end/last payment/last sync, view (not edit) usage, extend trial, pause/unpause, impersonate in read-only mode with a visible banner — every action audit-logged. Must be impossible to reach from a normal org account (tests).
```

Session: `/clear` · plan mode ON · After: `/security-review` → commit → `/clear`.

### Step 3.3 — Transactional emails

```text
React Email + nodemailer templates: welcome, verify email, staff invite, trial ending (3 days), invoice issued (PDF attached, bank details + payment reference), payment reminder, payment received, account paused (read-only) and unpaused, receipt, Z-report, export ready, import finished. From no-reply@tillflow.ie with reply-to support@tillflow.ie. Plain-text fallbacks; no personal data in subject lines.
```

Session: `/clear` · After: commit → `/clear`.

### Step 3.4 — Legal pages and GDPR tools

```text
Create pages (content drafts clearly marked "DRAFT – for solicitor review"): Terms of Service, Privacy Policy, Data Processing Agreement, Sub-processor list (Supabase, your hosting provider, your SMTP mail provider, Better Stack), Cookie policy, Accessibility statement. Add cookie consent for non-essential cookies only. Add in-app "Download my data" and "Close account" (30-day grace, then deletion except records Revenue requires us to keep for 6 years).
```

Session: `/clear` · After: commit → `/clear`.

### Step 3.5 — Accessibility audit (WCAG 2.2 AA)

```text
Use the accessibility-reviewer subagent across src/app. Then add automated axe checks to the Playwright suite for sign-up, onboarding, register, tender, back-office product editor and billing pages. Fix every serious/critical issue. Test keyboard-only and screen-reader labels on the register.
```

Session: `/clear` · After: commit → `/clear`.

### Step 3.6 — Security hardening

Session: `/clear` · **Opus**

```text
Security hardening pass per docs/PLAN.md section 10:
1. Use the tenant-isolation-auditor subagent on the whole repo; fix every finding with a regression test.
2. Verify: CSP, HSTS, secure cookies, CSRF on forms, rate limits on login/PIN/sync/exports/imports, Zod on every route, role checks on every server action, no service-role key in any client bundle (write a build-time check).
3. Secrets scan of the git history.
4. Write docs/SECURITY.md: threat model, data flows, incident response, how to rotate keys.
```

Then run, in order:

1. `/security-review` (current branch).
2. `/code-review` locally, and for the full release branch consider `/ultrareview` (deeper multi-agent review — see <https://code.claude.com/docs/en/ultrareview>).
3. Optionally install the Claude Security plugin for a whole-repo scan: <https://code.claude.com/docs/en/claude-security>.
4. Book an **independent human penetration test** — AI reviews do not replace it.

### Step 3.7 — Performance, backups and runbook

```text
1. Load test the sync endpoint and reports with k6: 300 orgs × 3 registers × 1 sale/10s for 30 minutes on staging; record p95 latency; add missing indexes.
2. Confirm Supabase PITR is on for prod; script and document a restore drill into a scratch project.
3. docs/RUNBOOK.md: outage steps, stuck sync, unmatched bank transfers, rotating keys, restoring data, contacting pilot shops.
4. Public status page link in the app footer.
```

Session: `/clear` · After: commit → `/clear`.

**Pilot gate:** pen test passed; offline tests lose no sales; restore drill done. Update `docs/STATUS.md`.

---

## Part F — Phase 4 · Pilot (weeks 18–21)

### Step 4.1 — Production go-live for pilot

```text
Prepare production: run the promote workflow to apply migrations to tillflow-prod; verify RLS check passes against prod schema (read-only); set Vercel production env vars checklist (I'll enter values); mark pilot organisations as "pilot" so no invoices are generated for 3 months; smoke-test script I can run after each deploy.
```

You do the credential entry yourself. Claude never sees live keys.

### Step 4.2 — Pilot onboarding kit

```text
Create docs/pilot/: a one-page quick-start per business type, a hardware checklist (tested printers, scanners and cash drawers, plus how to use the shop's own card terminal alongside Tillflow), an import template walkthrough, a "first day" checklist, and an in-app feedback button that creates a GitHub issue via a server route (no customer PII in the issue).
```

### Step 4.3 — Weekly fix loop

For each pilot bug:

```text
Read GitHub issue #<number> with `gh issue view <number>`. Reproduce it with a failing test first, then fix it, then run the full test suite. Keep the change minimal. Reference the issue in the commit message.
```

Tips for the pilot weeks:

- One bug = `/clear` + the prompt above. Use `/resume` only when returning to the same bug.
- For a batch of small UI fixes, run them in parallel sessions using git worktrees (<https://code.claude.com/docs/en/worktrees>).
- Ask your accountant to review a real week's VAT report and Z-reports from a pilot site.

**Launch gate:** pilot sites trade 2 weeks with no data errors. Update `docs/STATUS.md`.

---

## Part G — Phase 5 · Public launch

### Step 5.1 — tillflow.ie landing page

Build it in **Higgsfield** (your usual workflow) and deploy to **Hostinger**: hero, features by business type, Irish compliance section (VAT, GDPR, EU hosting), one clear price (the fixed monthly price, paid by bank transfer — no card needed), FAQs, "Start 14-day trial" linking to the app sign-up, and cards for Tillflow Finance plus "coming soon" apps. Keep claims factual (no "certified" wording you can't back up).

### Step 5.2 — Launch checklist (prompt)

```text
Create docs/LAUNCH.md and verify each item, marking pass/fail with evidence: bank details and VAT number correct on a sample invoice PDF; invoice numbering starts at 1 with no gaps; Z-report card totals match a pilot shop's terminal end-of-day report; legal pages reviewed by solicitor; DPA and sub-processor list published; status page live; error-alert emails reach my phone (send a test error and confirm); backups + PITR; restore drill < 30 days old; support email monitored; pricing matches landing page; trial emails firing; accessibility statement published; pen-test findings closed.
```

### Step 5.3 — After launch

- Weekly: `/clear` → "Using the Supabase MCP (read-only), summarise error_events with status = new from the last 7 days plus open GitHub issues; propose the top 5 fixes with effort."
- Consider Claude Code **routines** or **GitHub Actions** for scheduled dependency updates and nightly test runs: <https://code.claude.com/docs/en/routines>.
- v2 queue (from the plan): integrated card readers (Stripe Terminal / SumUp), automated billing via Stripe (card / SEPA Direct Debit), multi-location, loyalty & gift cards, KDS, Xero/Sage export, online ordering.

---

## Part H — Quick reference

| Command / feature                     | Use it for                                                                       |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| `/clear`                              | Start every new step with an empty context                                       |
| `/compact focus on …`                 | Shrink a long session but keep what matters                                      |
| `/context`                            | See how full the context window is                                               |
| `/rewind`                             | Undo to an earlier checkpoint (code + conversation)                              |
| Shift+Tab → plan mode                 | Make Claude plan before touching files                                           |
| `/model` → opusplan                   | Opus for planning, Sonnet for doing                                              |
| `/resume`, `claude --continue`        | Pick up a previous session                                                       |
| `/memory`                             | View/edit CLAUDE.md and auto-memory                                              |
| `/agents`                             | Manage subagents (tenant-isolation-auditor, vat-auditor, accessibility-reviewer) |
| `/hooks`                              | Check formatting, file protection and post-compact hooks                         |
| `/plugin`, `/reload-plugins`          | Install and activate plugins                                                     |
| `/mcp`                                | Connect/sign in to Supabase (staging, read-only)                                 |
| `/security-review`                    | Security pass on the current branch                                              |
| `/code-review`, `/ultrareview`        | Code review locally; deeper multi-agent review before release                    |
| `/write-spec` (your skill)            | Turn a feature into `docs/specs/*.md` before building                            |
| `/commit` (commit-commands plugin)    | Clean conventional commits                                                       |
| `pnpm verify` (your script, Step 0.8) | Check that Phase 0 is fully set up                                               |

Docs: [Best practices](https://code.claude.com/docs/en/best-practices) · [Context & compaction](https://code.claude.com/docs/en/context-window) · [Memory / CLAUDE.md](https://code.claude.com/docs/en/memory) · [Subagents](https://code.claude.com/docs/en/sub-agents) · [Skills](https://code.claude.com/docs/en/skills) · [Hooks](https://code.claude.com/docs/en/hooks-guide) · [Plugins](https://code.claude.com/docs/en/plugins/anthropic-marketplaces) · [Security guidance plugin](https://code.claude.com/docs/en/security-guidance) · [MCP](https://code.claude.com/docs/en/mcp)
