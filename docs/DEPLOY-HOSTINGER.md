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
   - Upstash Redis REST URL and token (one database per environment)
   - Sentry DSN (one Sentry project; the environment is set separately)

## A. Create the staging app

1. hPanel > **Websites** > **Add Website** > **Deploy Web App** (Node.js Apps) > **Import Git Repository**.
2. Click **Authorize** and allow Hostinger to read the `tillflow` repository on GitHub. Select it.
3. **Branch:** `develop`. If the wizard does not ask for a branch, set it under the app's **Settings > Git** afterwards. **(check)**
4. Build settings (Hostinger will auto-detect "Next.js"; override these):

   | Field            | Value                                                                           |
   | ---------------- | ------------------------------------------------------------------------------- |
   | Framework        | Next.js                                                                         |
   | Node.js version  | **24.x** (same as CI). 22.x is the fallback.                                    |
   | Root directory   | `./` (repo root)                                                                |
   | Package manager  | pnpm if offered; otherwise keep npm and use the build command below **(check)** |
   | Build command    | `corepack enable && pnpm install --frozen-lockfile && pnpm build`               |
   | Start command    | `npm start` (runs `next start`)                                                 |
   | Output directory | `.next`                                                                         |
   | Entry file       | leave empty                                                                     |

   If hPanel rejects `corepack`, try `npm install -g pnpm@12.6.0 && pnpm install --frozen-lockfile && pnpm build`. Do not switch to `npm install`: the lockfile is `pnpm-lock.yaml`, so versions would drift.

5. **Environment variables:** open the app's **Settings > Environment variables** and add the staging values from the table below **before the first deploy**. `NEXT_PUBLIC_*` values are baked in at build time, so changing one later means **Redeploy**.
6. Click **Deploy**. The first build takes a few minutes.
7. **Auto deploy:** in Settings > Git, make sure automatic deployment on push is ON for the branch. Then every merge to `develop` redeploys staging. **(check)**
8. **Domain:** Settings > **Domains** > connect `staging.tillflow.ie`. Hostinger shows the DNS record it wants (see the DNS section). Tick **Force HTTPS** once the free SSL certificate is issued.
9. Open `https://staging.tillflow.ie/api/health`. You should see `{"status":"ok","version":"...","commit":"...","environment":"staging"}`.
10. On GitHub: repo > Settings > Secrets and variables > Actions > **Variables** > New repository variable `STAGING_URL` = `https://staging.tillflow.ie`. This turns on the "Staging smoke check" that runs after each push to `develop`.

## B. Create the production app

Repeat section A with these differences:

- Branch **`main`**, domain **`pos.tillflow.ie`**.
- Production Supabase (`tillflow-prod`), production Upstash and Sentry values. `NEXT_PUBLIC_APP_ENV=production`.
- Consider switching **auto deploy OFF** so production moves only when you press **Redeploy**. Release order: merge `develop` into `main` by PR, run **Promote to production** on GitHub (approve it) so the database is ready, then **Redeploy** the production app.

## Environment variables to paste into hPanel

Names only. Values come from your password manager. Same names in both apps, different values.

| Name                                                      | Needed now? | Notes                                                                                               |
| --------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_APP_URL`                                     | yes         | `https://staging.tillflow.ie` / `https://pos.tillflow.ie`                                           |
| `NEXT_PUBLIC_APP_ENV`                                     | yes         | `staging` / `production`                                                                            |
| `NEXT_PUBLIC_SUPABASE_URL`                                | yes         | from that environment's Supabase project                                                            |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`                           | yes         | anon (publishable) key only                                                                         |
| `AUTH_GOOGLE_ENABLED`                                     | yes         | `true` only after Google is enabled in that Supabase project                                        |
| `UPSTASH_REDIS_REST_URL`                                  | yes         | without it the app falls back to in-memory rate limits, which is not safe in production             |
| `UPSTASH_REDIS_REST_TOKEN`                                | yes         |                                                                                                     |
| `SENTRY_DSN`                                              | yes         | server errors                                                                                       |
| `NEXT_PUBLIC_SENTRY_DSN`                                  | yes         | browser errors                                                                                      |
| `SENTRY_AUTH_TOKEN`                                       | optional    | uploads source maps during the build; without it Sentry still works, stack traces are just minified |
| `SENTRY_ORG`, `SENTRY_PROJECT`                            | optional    | only used with `SENTRY_AUTH_TOKEN`                                                                  |
| `SUPABASE_SERVICE_ROLE_KEY`                               | later       | server only; add when server code needs it                                                          |
| `DATABASE_URL`                                            | later       | pooled connection string                                                                            |
| `RESEND_API_KEY`, `EMAIL_FROM`                            | later       | when the app sends email                                                                            |
| `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`                | later       | when Inngest jobs land                                                                              |
| `BANK_ACCOUNT_NAME`, `BANK_IBAN`, `BANK_BIC`, `BANK_NAME` | later       | billing invoices (phase 3)                                                                          |

`SUPABASE_SERVICE_ROLE_KEY` and `DATABASE_URL` must never start with `NEXT_PUBLIC_`.

`.env.example` is write-protected for Claude, so add these three lines to it by hand: `NEXT_PUBLIC_APP_ENV=development`, `SENTRY_ORG=`, `SENTRY_PROJECT=`.

## After each app is live

- Supabase dashboard (that project) > Authentication > URL Configuration: set **Site URL** to the app URL and add `<app URL>/auth/callback` to **Redirect URLs**. See `docs/specs/auth.md` for the rest of the auth settings.
- Sentry: trigger a test error on staging and confirm it shows up with no email or name in it.

## Why not `output: 'standalone'`?

Hostinger runs the build and start commands you give it, and `next start` works with the default output. `standalone` is for Docker or copying a minimal folder to a server, and it changes how the app must be started. It is left off. If Hostinger support says it is required, add `output: "standalone"` to `next.config.ts`, copy `public` and `.next/static` into `.next/standalone`, and start with `node .next/standalone/server.js`.

## DNS records (hPanel > Domains > tillflow.ie > DNS / Nameservers)

Assumes `tillflow.ie` uses Hostinger's nameservers. For the two app rows, use the value hPanel shows on each app's Domains step; Hostinger generates it.

| Type       | Name                | Value                                                                     | TTL  | Purpose                             |
| ---------- | ------------------- | ------------------------------------------------------------------------- | ---- | ----------------------------------- |
| A or CNAME | `pos`               | shown by hPanel when you connect `pos.tillflow.ie` to the production app  | 300  | Production app                      |
| A or CNAME | `staging`           | shown by hPanel when you connect `staging.tillflow.ie` to the staging app | 300  | Staging app                         |
| MX         | `send`              | `feedback-smtp.eu-west-1.amazonses.com` (priority `10`)                   | 3600 | Resend: bounce handling             |
| TXT        | `send`              | `v=spf1 include:amazonses.com ~all`                                       | 3600 | Resend: SPF                         |
| TXT        | `resend._domainkey` | the long `p=...` key shown in Resend                                      | 3600 | Resend: DKIM                        |
| TXT        | `_dmarc`            | `v=DMARC1; p=none; rua=mailto:dmarc@tillflow.ie`                          | 3600 | Recommended DMARC (start at `none`) |

Resend specifics:

1. resend.com > Domains > **Add Domain** > `tillflow.ie`, region **Europe (Ireland, eu-west-1)**.
2. Resend then lists the exact records for your domain. **Those values win** over the table above: the DKIM key is unique to you and host names can differ. Add them, then click **Verify**.
3. Do not create a second SPF record on the same name. The record above is on `send`, so it does not clash with any SPF on the root domain.
4. Leave the existing landing-page records for `tillflow.ie` and `www` alone.
