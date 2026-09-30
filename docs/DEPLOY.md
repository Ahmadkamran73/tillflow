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
| App keys (Supabase anon/service, Upstash, Sentry, Resend) | hPanel environment variables of each app      | that app only                             |
| Local values                                              | `.env.local` on your laptop (never committed) | you                                       |

Claude Code never sees production values, and CI needs no secrets at all.

## Monitoring

- **Errors:** Sentry. Personal data is scrubbed before sending: no user, cookies, request bodies, emails or names.
- **Uptime:** Better Stack pings `/api/health` on staging and production (settings below).
- **Health endpoint:** `/api/health` returns `{"status":"ok","version","commit","environment"}`. It is public and reveals no data. The `commit` shows exactly what is deployed.

### Better Stack uptime monitors (betterstack.com > Uptime > Monitors > Create monitor)

| Setting                        | Production                                      | Staging                                  |
| ------------------------------ | ----------------------------------------------- | ---------------------------------------- |
| Monitor type                   | HTTP / website status                           | HTTP / website status                    |
| URL                            | `https://pos.tillflow.ie/api/health`            | `https://staging.tillflow.ie/api/health` |
| Alert us when                  | URL responds with a non-2xx status              | same                                     |
| Required keyword (recommended) | `"status":"ok"`                                 | same                                     |
| Check frequency                | 1 minute                                        | 3 minutes                                |
| Request timeout                | 15 seconds                                      | 30 seconds                               |
| Confirmation period            | 60 seconds                                      | 180 seconds                              |
| Regions                        | Europe                                          | Europe                                   |
| Follow redirects               | on                                              | on                                       |
| SSL / domain expiry check      | on, warn 14 days ahead                          | on                                       |
| Notify                         | your email and phone                            | email only                               |
| Status page                    | add to the public status page (PLAN section 11) | do not add                               |

## Rolling back

- **App:** in hPanel, redeploy the previous commit, or revert the merge on GitHub and let it redeploy.
- **Database:** migrations are forward-only. Fix a bad one with a **new** migration, never by editing an old one. Supabase keeps point-in-time backups for production.

## One-time GitHub settings

- Environments `staging` and `production` (production needs your approval).
- Branch protection on `main`: pull request required, CI must pass, no direct pushes.
- Dependabot for npm and GitHub Actions.
- Secret scanning: only if your GitHub plan offers it for private repos.
