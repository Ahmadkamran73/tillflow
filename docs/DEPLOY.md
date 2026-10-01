# How Tillflow POS gets from your laptop to the shops

Plain-English guide to every environment. Click-by-click Hostinger steps are in `docs/DEPLOY-HOSTINGER.md`.

## The four places the app runs

| Environment    | What it is                                                  | Database                                             | Who uses it                         | How it updates                       |
| -------------- | ----------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| **Local**      | Your laptop (`pnpm dev`)                                    | Local Supabase in Docker (`supabase start`)          | You                                 | Instantly, as you save               |
| **CI**         | A temporary GitHub machine that tests each pull request     | A throwaway local Supabase started inside the runner | Nobody; it disappears after the run | On every pull request                |
| **Staging**    | `staging.tillflow.ie`, a full copy for trying things safely | `tillflow-staging` Supabase project (Ireland)        | You and testers, fake data only     | Automatically when `develop` changes |
| **Production** | `pos.tillflow.ie`, the real thing shops use                 | `tillflow-prod` Supabase project (Ireland)           | Paying shops                        | Only when you deliberately release   |

Real customer data lives only in production. Staging and CI never hold real data.

## The route a change takes

1. Work on a **feature branch** and open a **pull request** into `develop`.
2. **CI** runs automatically: lint, typecheck, unit tests, database security tests (Shop A cannot see Shop B), a production build, and browser tests.
3. Merge into **`develop`**. Hostinger rebuilds **staging** by itself. If the change contains database migrations, the **Migrate staging** workflow applies them to the staging database. The **smoke check** then confirms `/api/health` reports the new commit.
4. Try it on staging.
5. Happy? Open a pull request **`develop` into `main`**. `main` is protected: nobody pushes to it directly and CI must pass.
6. Release: run **Promote to production** on GitHub (Actions tab > Run workflow, branch `main`). It **pauses until you approve it** in the `production` environment, then applies the migrations to the production database.
7. Redeploy the production app in hPanel (or let it auto-deploy from `main` if you left that on). Check `https://pos.tillflow.ie/api/health`.

Migrations go first and the app second, so new code never runs against an old database. Write migrations so the previous app version still works with them.

## What each automatic job does

| Workflow                 | Runs when                                                                  | What it does                                                | Touches                    |
| ------------------------ | -------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------- |
| `ci.yml`                 | every PR into `main` or `develop`                                          | full test suite on a throwaway stack                        | nothing outside the runner |
| `ci.yml` (smoke)         | push to `develop`, if the `STAGING_URL` variable is set                    | waits until staging is healthy on the new commit            | staging (read only)        |
| `migrate-staging.yml`    | push to `main` or `develop` that changes `supabase/migrations`, or by hand | `supabase db push`                                          | staging database           |
| `promote-production.yml` | by hand only, then needs your approval                                     | `supabase db push`                                          | production database        |
| Dependabot               | weekly                                                                     | opens PRs for npm and GitHub Actions updates into `develop` | nothing until merged       |

## Secrets: where each one lives

| Secret                                                    | Lives in                                      | Seen by                                   |
| --------------------------------------------------------- | --------------------------------------------- | ----------------------------------------- |
| Staging DB password, access token, project ref            | GitHub environment `staging`                  | the Migrate staging workflow              |
| Production DB password, access token, project ref         | GitHub environment `production`               | the Promote workflow, after your approval |
| App keys (Supabase anon key, `JOBS_DATABASE_URL`, Resend) | hPanel environment variables of each app      | that app only                             |
| Local values                                              | `.env.local` on your laptop (never committed) | you                                       |

Claude Code never sees production values, and CI needs no secrets at all.

## Monitoring

- **Errors:** our own error log in Postgres (see "Where do errors go?" below).
- **Uptime:** two Better Stack monitors per environment on `/api/health` (settings below).
- **Health endpoint:** `/api/health` returns `{"status":"ok","database":"ok","jobs":"ok"|"down","version","commit","environment"}`. It is public and reveals no data. It answers **200 whenever the database answers**, even when jobs are down, and **503 only when the database is down**. `"jobs"` is `"ok"` when the background worker's heartbeat is under 5 minutes old. The `commit` shows exactly what is deployed.

## Where do errors go?

- **Server errors** (pages, route handlers, server actions, the proxy) are caught by `onRequestError` in `src/instrumentation.ts`. **Browser errors** are sent by a small reporter in the root layout (and `global-error.tsx`) to `POST /api/log-error`, which only accepts same-origin requests up to 8 KB, 20 a minute per IP. **Job errors** are caught in `src/lib/jobs`.
- All of them go through `src/lib/errors`: an allow-list scrubber removes personal data (emails, tokens, IPs, phone numbers, IBANs, Eircodes, query strings), then the error is written as one JSON line to the app log (pino, visible in hPanel's logs) and upserted into the **`error_events`** table in that environment's Supabase database, grouped by a **fingerprint** (same error = same row, with a count and first/last seen).
- **Alert email:** the first time a server or job error fingerprint is seen (or when an error you marked `resolved` comes back), an email goes to `ALERT_EMAIL` via Resend: at most one per fingerprint per hour and at most **10 alerts an hour in total**. **Browser** reports never trigger an instant email (anyone can post to `/api/log-error`, so they could otherwise fill your inbox or put their own text in it); they appear in the **daily digest** of open errors, sent after 08:00 Irish time.
- **Each row** holds: fingerprint, source (`server`, `browser` or `job`), scrubbed message and stack, route (path only), environment, `context` (allow-listed: method, status, digest, commit, and `org_id`/`user_id` only when they are UUIDs), count, first/last seen, status.
- **Reading it:** Supabase dashboard > (staging or production project) > Table Editor > `error_events`, sorted by `last_seen_at`. Or ask Claude Code: the Supabase MCP in `.mcp.json` is read-only and points at staging, so "list the newest rows in error_events" works there (never on production).
- **Triage:** set `status` to `resolved` (you get an alert again if it recurs) or `ignored` (never alert again) in the Table Editor, or with SQL in the SQL editor: `update error_events set status = 'resolved' where fingerprint = '…';`. Rows unseen for 90 days are deleted automatically.
- Clients can never read or write these tables: RLS is on with a deny-all policy and all grants are revoked. Only the server's `src/lib/ops/db.ts` reaches them, through SECURITY DEFINER functions.

### Reading a browser stack trace

The app ships minified JavaScript and never serves source maps. The **Source maps** workflow (`.github/workflows/source-maps.yml`) rebuilds every push to `develop` and `main` with the same public values as staging/production and keeps the `.map` files as an artifact named `source-maps-<environment>-<commit>` for 30 days. To read a browser error: take `commit` from the error's `context`, open GitHub > Actions > Source maps > that commit's run > download the artifact, then map the `file:line:column` from the stack with any source-map tool (for example `npx source-map-cli resolve <file>.js.map <line> <column>`). The maps contain our source code, which is fine while the repo is public; if the repo goes private, artifacts go private with it.

The workflow needs these repository **variables** (public values, not secrets): `STAGING_SUPABASE_URL`, `STAGING_SUPABASE_ANON_KEY`, and later `PROD_SUPABASE_URL`, `PROD_SUPABASE_ANON_KEY`. Until they exist it skips with a warning.

## Background jobs

pg-boss (a job queue stored in Postgres, schema `pgboss`, migration 0007) runs inside the app's Node.js process, started from `src/instrumentation.ts` unless `JOBS_ENABLED=false`. It connects with `JOBS_DATABASE_URL` as the least-privilege **`tillflow_ops`** role (migration 0008: it can run the `ops.*` functions and owns the `pgboss` schema, and cannot touch any business table; tests in `tests/rls/ops-role.test.ts`) through the Supabase **session pooler**, max 3 connections, plus 2 for the error log and rate limiter). Each job type is a handler in `src/lib/jobs/handlers/` with a Zod-checked payload (tenant jobs carry `org_id`); `enqueue(name, payload)` in `src/lib/jobs` validates and queues it. Failed jobs retry 3 times with backoff (30 s, 60 s, 120 s), then stay `failed` in `pgboss.job` and are reported to `error_events`. Scheduled jobs, all hourly: rate-limit cleanup, error prune (daily work behind a last-run guard), error digest (after 08:00 Dublin, once a day), and a heartbeat every minute. Because they run hourly with last-run guards stored in the database, a day's work is caught up on the next hour if the app was stopped or asleep. Tests (`tests/rls/jobs.test.ts`) prove a job runs once, a failing job retries then fails, a bad payload is rejected, and two workers never run the same job.

Rate-limit policies (login, reset, MFA, exports, imports) are listed in `docs/specs/auth.md` and `src/lib/rate-limit`. Auth limits fail closed, others fail open; `/api/v1/sync/*` and `/api/log-error` use a per-process in-memory limiter.

### Does the Hostinger app stay running?

**Not confirmed yet.** Hostinger's public docs for Node.js Web Apps do not say whether an app with no traffic keeps running or is stopped. The question has been sent to Hostinger support; their answer goes here. Until then the design is sleep-tolerant: jobs catch up after a pause, `"jobs":"down"` shows up in `/api/health` if the worker stops, and the 1-minute Better Stack check keeps traffic flowing.

### Better Stack uptime monitors (betterstack.com > Uptime > Monitors > Create monitor)

Create **two monitors per environment**, both on `/api/health`:

1. **App** (table below): alerts when the app or database is down.
2. **Jobs**: same settings, but **Required keyword** `"jobs":"ok"`, name it "… jobs", and set **Confirmation period** so it alerts only after **2 consecutive failed checks** (2 minutes on production, 6 on staging). A deploy can briefly show `"jobs":"down"` until the first heartbeat.

| Setting                        | Production                                                    | Staging                                  |
| ------------------------------ | ------------------------------------------------------------- | ---------------------------------------- |
| Monitor type                   | HTTP / website status                                         | HTTP / website status                    |
| URL                            | `https://pos.tillflow.ie/api/health`                          | `https://staging.tillflow.ie/api/health` |
| Alert us when                  | URL responds with a non-2xx status, or the keyword is missing | same                                     |
| Required keyword (recommended) | `"status":"ok"`                                               | same                                     |
| Check frequency                | 1 minute                                                      | 3 minutes                                |
| Request timeout                | 15 seconds                                                    | 30 seconds                               |
| Confirmation period            | 120 seconds (2 failed checks)                                 | 360 seconds (2 failed checks)            |
| Regions                        | Europe                                                        | Europe                                   |
| Follow redirects               | on                                                            | on                                       |
| SSL / domain expiry check      | on, warn 14 days ahead                                        | on                                       |
| Notify                         | your email and phone                                          | email only                               |
| Status page                    | add to the public status page (PLAN section 11)               | do not add                               |

## Rolling back

- **App:** in hPanel, redeploy the previous commit, or revert the merge on GitHub and let it redeploy.
- **Database:** migrations are forward-only. Fix a bad one with a **new** migration, never by editing an old one. Supabase keeps point-in-time backups for production.

## One-time GitHub settings

- Environments `staging` and `production` (production needs your approval).
- Branch protection on `main`: pull request required, CI must pass, no direct pushes.
- Dependabot for npm and GitHub Actions.
- Branch protection on `develop`: CI must pass, no force push, no required approvals.
- Secret scanning and push protection (on while the repo is public; a private repo needs a paid plan).

## Why no Sentry, Upstash or Inngest

They were planned and then dropped in step 0.6: their free tiers would not cope with production, and each one is another sub-processor holding data about our shops plus more secrets to manage. Errors, rate limits and background jobs now run on the Supabase Postgres we already have (EU, backed up, covered by our DPA), as described above.
