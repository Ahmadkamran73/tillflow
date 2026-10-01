# Auth (step 0.5)

Supabase Auth behind `src/lib/auth`. Nothing else in the app imports a provider SDK.

## Flows

| Flow                                    | Route                                         | Notes                                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign up                                 | `/signup`                                     | email + password + business name; email confirmation required; same reply for new and existing emails                                                                                                  |
| Confirm email / magic link / reset link | `/auth/callback?token_hash=…&type=…&next=…`   | custom email templates (`supabase/templates`) carry a `token_hash`, so a link works on any device                                                                                                      |
| Log in                                  | `/login`                                      | password; generic error; `?next=` is same-site paths only (`safeNext`)                                                                                                                                 |
| Magic link                              | `/magic-link`                                 | sign-in only, never creates an account                                                                                                                                                                 |
| Password reset                          | `/forgot-password` → link → `/reset-password` | an owner (or anyone with a TOTP factor) passes the authenticator challenge first; other sessions are signed out after the change                                                                       |
| MFA                                     | `/mfa`                                        | enrol (QR + setup key) or challenge; owners are required, anyone with a verified factor is required                                                                                                    |
| Google                                  | button on `/login` and `/signup`              | behind `AUTH_GOOGLE_ENABLED=true`; refused in the callback for cashier-only users                                                                                                                      |
| First org                               | `/start`                                      | a signed-in user with no membership explicitly creates a business (form POST, name pre-filled) via `public.create_my_organisation` (one transaction, caller's own JWT), then `/mfa` then `/onboarding` |

## Authorisation

- `requireRole(["owner","manager"], orgId)` — call it in every back-office page, layout, server action and route handler. Non-member, wrong role and malformed id all return the same 404. Owners must be at aal2.
- `requireBackOffice(next)` — for pages not tied to a URL org (`/o`, `/onboarding`).
- `src/proxy.ts` refreshes the session and redirects logged-out visitors from `/o`, `/onboarding`, `/mfa`, `/reset-password`. It is an optimistic check, not authorisation.
- The same two rules are enforced in the database (migration 0005): owners and anyone with a verified TOTP factor only get org data on an aal2 JWT, and OAuth sessions never carry cashier access. An aal1 session can read only its own membership rows.
- Membership is read through RLS with the user's JWT. The service-role key is not used anywhere in the request path.

## Rate limits

Policies live in `RATE_LIMITS` in `src/lib/rate-limit`:

| Limit                                            | Key              | Allowed                                        |
| ------------------------------------------------ | ---------------- | ---------------------------------------------- |
| `login` (also Google start)                      | IP + email       | 5 per minute                                   |
| `login-account` (password sign-in)               | email            | 20 per 15 minutes (stops IP-rotation guessing) |
| `sign-up`, `magic-link`                          | IP + email       | 5 per minute                                   |
| `reset-account` (reset request, password update) | email or user id | 3 per hour                                     |
| `reset-ip` (reset request)                       | IP               | 10 per hour                                    |
| `mfa` (enrol, challenge)                         | user id          | 5 per minute                                   |

Counted in Postgres by `ops.check_rate_limit()` (migration 0006: one atomic `INSERT … ON CONFLICT`, fixed window), which returns allowed, remaining and retry-after, so every app instance shares the count and the user is told how long to wait ("Try again in 25 minutes."). Identifiers are SHA-256 hashed in `src/lib/rate-limit` before they reach the database; only the hash is stored.

**Fails closed.** If the database cannot be asked, the attempt is refused with a generic "We can't process this right now. Please try again shortly." and the failure is logged to `error_events`. Sign-in needs the database anyway, so this locks nobody out who could otherwise get in. (Changed from the earlier fail-open design in step 0.6.)

Cashier PIN lockout (5 failures) is a separate per-membership counter in the database, not this limiter.

## Local vs hosted config

`supabase/config.toml` configures local dev only. For staging and production set, in the Supabase dashboard: Site URL, redirect URLs (`<origin>/**`), minimum password length 10, email confirmations on, TOTP MFA enabled, the three email templates from `supabase/templates`, and (when Google is on) the Google provider.

## Not built yet

Invite/accept flow for managers and cashiers, cashier PIN unlock (must never accept Google), org switcher for users in several orgs.
