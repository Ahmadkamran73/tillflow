# Superadmin console (`/superadmin`)

For the Tillflow owner only. Lists businesses, shows usage, extends trials, pauses and unpauses, opens read-only views of a business, and holds the billing panel (moved from `/admin/billing`; `/admin` is gone).

## Who can get in (all locks must pass; anything else is a plain 404)

1. **IP allowlist** `SUPERADMIN_IP_ALLOWLIST` (comma list of IPv4/IPv6 addresses or IPv4 CIDR; `/0` is refused). Checked in `src/proxy.ts` before any session work and again in `requireSuperadmin`. **Unset or empty = nobody gets in.** Caller IP = `X-Real-IP`, else the last `X-Forwarded-For` entry (the first is client-controlled). Code: `src/lib/superadmin/ip.ts`.
2. **A `platform_admins` row** (inserted by hand in SQL per environment; no UI adds admins) and **a two-step (aal2) session** (`app.is_platform_admin()`). A user without a factor, or one-step, never sees the console; a one-step user with a factor is sent to `/mfa` like any other page.
3. **Every database function checks `app.is_platform_admin()` again** (`0057`), so a stolen page path or a direct API call from a business account gets `42501`.

Every page and server action calls `requireSuperadmin()` itself (a layout is not a boundary). Actions are rate limited (`superadmin`, 120 per hour per admin).

## Screens

- `/superadmin`: businesses (search, 25 per page): account status, billing status, trial end, last payment, last sync (newest of last sale received and till last seen).
- `/superadmin/orgs/<id>`: usage counts (never rows), Extend trial (1 to 90 days, only while on trial), Pause, Unpause, with a required reason (5 to 300 characters, kept in the audit log; no customer details).
- `/superadmin/orgs/<id>/view/{dashboard,sales,products,staff,shifts}`: read-only views. The admin never gets the owner's session and the tenant RLS helper is untouched; each page reads one `admin_view_*` function. A red banner sits in the layout. There is no form, button or action under it. Staff shows names, roles and kind only (no PIN hash, ids, emails); products show no cost prices; sales show no cashier or customer.
- `/superadmin/billing`: unchanged behaviour (Mark as paid, unpause, bank statement matcher).

## Audit

Every change and every per-business read writes an `audit_log` row against that business with `actor_user_id` = the admin: `superadmin.trial_extended` (old and new end, days, note), `superadmin.paused`, `billing.unpaused` (existing), `superadmin.viewed` (page name). The business list and the banner name lookup are not audited (rows belong to one business). Mark paid keeps its own `billing.marked_paid`.

## Decisions and limits

- The IP is only as trustworthy as the host's proxy: Hostinger sets `X-Real-IP` (support confirmed 2026-10-02). If a request could reach the app without that proxy, a client could send its own `X-Real-IP`; the admin and aal2 locks still hold. Verify on staging.
- Keep the allowlist current: a changed home IP locks you out (intended). Change the env var and redeploy.
- Pause here is the same state as the dunning pause; paused months are not billed (`resumed_on` rule from billing).
- Extending a trial moves `organisations.trial_ends_at`, which the `billing-invoices` job reads, so the first invoice follows the new date.

## Tests

`tests/unit/superadmin-ip.test.ts`, `tests/rls/superadmin.test.ts` (every function refused for owner, manager, cashier, other shop, aal1 admin, anon; audit rows; allow-listed output keys; bounds), `tests/e2e/superadmin.spec.ts` (normal owner gets 404 everywhere incl. a forged action POST; admin from another or no address gets 404; admin flow and read-only views have no forms), `tests/e2e/billing.spec.ts` (moved paths).
