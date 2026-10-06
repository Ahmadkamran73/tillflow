# Deploying Tillflow POS on Hostinger (click by click)

Hosting decision: **Hostinger Node.js Web Apps** (EU data centre). There is no Hostinger CLI, so this is all done in hPanel.
hPanel changes its labels now and then; if a button is named slightly differently, pick the closest one. Steps marked **(check)** are the ones that could not be verified without your hPanel, so confirm them on screen.

You create **two** Web Apps from the same GitHub repo:

| App        | Domain                | Git branch | Supabase project                | `NEXT_PUBLIC_APP_ENV` |
| ---------- | --------------------- | ---------- | ------------------------------- | --------------------- |
| Staging    | `staging.tillflow.ie` | `develop`  | `tillflow-staging`              | `staging`             |
| Production | `pos.tillflow.ie`     | `main`     | `tillflow-prod` (you create it) | `production`          |

Do staging first. Do not start production until staging `/api/health` returns 200.

## Before you start

1. Confirm your Hostinger plan includes **Node.js Web Apps** (Business or Cloud tiers) and choose an **EU** data centre when asked.
2. The `develop` branch exists on GitHub (created by the delivery setup).
3. Have these ready in your password manager (never paste them into chat):
   - Staging Supabase URL and anon key (Supabase dashboard, `tillflow-staging` > Project Settings > API)
   - Staging service-role key and pooled `DATABASE_URL` (only needed once server code uses them)
   - Staging `JOBS_DATABASE_URL`, which connects as the least-privilege **`tillflow_ops`** role (migration 0008), never as `postgres`. After the migrations reach staging (step 4 of the release route in `docs/DEPLOY.md`):
     1. Supabase dashboard > `tillflow-staging` > **SQL Editor**, run `alter role tillflow_ops with login password '<a new strong password>';` (generate it in your password manager and save it there; never paste it into chat).
     2. Dashboard > **Connect** > **Session pooler** (port **5432**, not the 6543 transaction pooler; not the direct connection, which is IPv6-only). Copy the URI and change the user from `postgres.<project-ref>` to **`tillflow_ops.<project-ref>`** and the password to the one from step 1. **(check)** that the pooler accepts it: the app's `/api/health` says `"database":"ok"`.
   - SMTP details for alert emails (for now a Gmail account with 2-step verification and an **app password**: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=465`, `SMTP_USER` = the Gmail address, `SMTP_PASS` = the 16-character app password), and the address that receives alerts for `ALERT_EMAIL`

## A. Create the staging app

1. hPanel > **Websites** > **Add Website** > **Deploy Web App** (Node.js Apps) > **Import Git Repository**.
2. Click **Authorize** and allow Hostinger to read the `tillflow` repository on GitHub. Select it.
3. **Branch:** `develop`. If the wizard does not ask for a branch, set it under the app's **Settings > Git** afterwards. **(check)**
4. Build settings (Hostinger will auto-detect "Next.js"; override these):

   | Field            | Value                                                                               |
   | ---------------- | ----------------------------------------------------------------------------------- |
   | Framework        | Next.js                                                                             |
   | Node.js version  | **24.x** (same as CI). 22.x is the fallback.                                        |
   | Root directory   | `./` (repo root)                                                                    |
   | Package manager  | **pnpm** (hPanel detects it from `pnpm-lock.yaml` and installs dependencies itself) |
   | Build command    | `pnpm run build` (pick it from the list; hPanel does not accept free text)          |
   | Start command    | `pnpm run start` (runs `next start`)                                                |
   | Output directory | `.next`                                                                             |
   | Entry file       | leave empty                                                                         |

   If the build log shows `npm install` instead of `pnpm install`, stop and ask support how to use the pnpm lockfile: an npm install ignores `pnpm-lock.yaml`, so versions would drift.

5. **Environment variables:** open the app's **Settings > Environment variables** and add the staging values from the table below **before the first deploy**. `NEXT_PUBLIC_*` values are baked in at build time, so changing one later means **Redeploy**.
6. Click **Deploy**. The first build takes a few minutes.
7. **Auto deploy:** in Settings > Git, make sure automatic deployment on push is ON for the branch. Then every merge to `develop` redeploys staging. **(check)**
8. **Domain:** Settings > **Domains** > connect `staging.tillflow.ie`. Hostinger shows the DNS record it wants (see the DNS section). Tick **Force HTTPS** once the free SSL certificate is issued.
9. Open `https://staging.tillflow.ie/api/health`. You should see `{"status":"ok","database":"ok","jobs":"ok","version":"...","commit":"...","environment":"staging"}`. Right after a deploy `"jobs"` can say `"down"` for up to a minute, until the worker's first heartbeat.
10. On GitHub: repo > Settings > Secrets and variables > Actions > **Variables** > New repository variable `STAGING_URL` = `https://staging.tillflow.ie`. This turns on the "Staging smoke check" that runs after each push to `develop`.

## B. Create the production app

Repeat section A with these differences:

- Branch **`main`**, domain **`pos.tillflow.ie`**.
- Production Supabase (`tillflow-prod`) values, including its own session-pooler `JOBS_DATABASE_URL` as `tillflow_ops` (run the same `alter role` in the production SQL editor with a different password). `NEXT_PUBLIC_APP_ENV=production`. `ALERT_FROM` is the sending Gmail address for now (Gmail rewrites any other From). Once a `tillflow.ie` mailbox exists, switch the `SMTP_*` values and `ALERT_FROM` to it and publish its SPF/DKIM records.
- Consider switching **auto deploy OFF** so production moves only when you press **Redeploy**. Release order: merge `develop` into `main` by PR, run **Promote to production** on GitHub (approve it) so the database is ready, then **Redeploy** the production app.

## Environment variables to paste into hPanel

Names only. Values come from your password manager. Same names in both apps, different values.

| Name                                                      | Needed now? | Notes                                                                                                                                                                                         |
| --------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                                     | yes         | `https://staging.tillflow.ie` / `https://pos.tillflow.ie`                                                                                                                                     |
| `NEXT_PUBLIC_APP_ENV`                                     | yes         | `staging` / `production`                                                                                                                                                                      |
| `NEXT_PUBLIC_SUPABASE_URL`                                | yes         | from that environment's Supabase project                                                                                                                                                      |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                           | yes         | anon (publishable) key only                                                                                                                                                                   |
| `AUTH_GOOGLE_ENABLED`                                     | yes         | `true` only after Google is enabled in that Supabase project                                                                                                                                  |
| `JOBS_DATABASE_URL`                                       | yes         | Supabase **session pooler** URL (port 5432) with user `tillflow_ops.<project-ref>`, never `postgres`. Used for background jobs, rate limits, the error log and the health check. Server only. |
| `JOBS_ENABLED`                                            | optional    | leave unset (on). `false` stops this app running the job worker.                                                                                                                              |
| `ALERT_EMAIL`                                             | yes         | where new-error alerts and the daily digest go                                                                                                                                                |
| `ALERT_FROM`                                              | yes         | sender, e.g. `Tillflow Alerts <your-gmail-address>`; must be the SMTP account's own address on Gmail                                                                                          |
| `SMTP_HOST`                                               | yes         | `smtp.gmail.com` (later your tillflow.ie mailbox host)                                                                                                                                        |
| `SMTP_PORT`                                               | optional    | `465` (default, implicit TLS) or `587` (STARTTLS)                                                                                                                                             |
| `SMTP_USER`                                               | yes         | the SMTP login (the Gmail address)                                                                                                                                                            |
| `SMTP_PASS`                                               | yes         | Gmail **app password**, never the account password. Without the `SMTP_*` set, alerts are skipped (errors are still stored).                                                                   |
| `SUPABASE_SERVICE_ROLE_KEY`                               | later       | server only; add when server code needs it                                                                                                                                                    |
| `DATABASE_URL`                                            | later       | pooled connection string                                                                                                                                                                      |
| `EMAIL_FROM`                                              | later       | receipts and invites (later steps)                                                                                                                                                            |
| `BANK_ACCOUNT_NAME`, `BANK_IBAN`, `BANK_BIC`, `BANK_NAME` | later       | billing invoices (phase 3)                                                                                                                                                                    |

`SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` and `JOBS_DATABASE_URL` must never start with `NEXT_PUBLIC_`.

`.env.example` is write-protected for Claude; its lines are updated by hand to match this table.

## After each app is live

- Supabase dashboard (that project) > Authentication > URL Configuration: set **Site URL** to the app URL and add `<app URL>/auth/callback` to **Redirect URLs**. See `docs/specs/auth.md` for the rest of the auth settings.
- Errors: trigger a test error on staging and confirm it lands in the `error_events` table (Supabase > Table Editor) and that the alert email contains no name or email address. See "Where do errors go?" in `docs/DEPLOY.md`.

## Why not `output: 'standalone'`?

Hostinger runs the build and start commands you give it, and `next start` works with the default output. `standalone` is for Docker or copying a minimal folder to a server, and it changes how the app must be started. It is left off. If Hostinger support says it is required, add `output: "standalone"` to `next.config.ts`, copy `public` and `.next/static` into `.next/standalone`, and start with `node .next/standalone/server.js`.

## DNS records (hPanel > Domains > tillflow.ie > DNS / Nameservers)

`tillflow.ie`'s DNS is at **eLive** (nameservers `dns.elive.ie`), not Hostinger, so add these records in the eLive control panel. For the two app rows, use the value hPanel shows on each app's Domains step (staging: `A` `72.61.204.157`).

| Type       | Name      | Value                                                                     | TTL  | Purpose                             |
| ---------- | --------- | ------------------------------------------------------------------------- | ---- | ----------------------------------- |
| A or CNAME | `pos`     | shown by hPanel when you connect `pos.tillflow.ie` to the production app  | 300  | Production app                      |
| A or CNAME | `staging` | shown by hPanel when you connect `staging.tillflow.ie` to the staging app | 300  | Staging app                         |
| TXT        | `_dmarc`  | `v=DMARC1; p=none; rua=mailto:dmarc@tillflow.ie`                          | 3600 | Recommended DMARC (start at `none`) |

Email: no sending-domain DNS records are needed while alerts go out through Gmail SMTP. When a `tillflow.ie` mailbox is created, add the SPF, DKIM and DMARC records its provider gives you, and do not create a second SPF record on the same name. Leave the existing landing-page records for `tillflow.ie` and `www` alone.
