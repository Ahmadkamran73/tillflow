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

5 per minute per IP + email (hashed) for login, magic link, reset request and sign-up; 5 per minute per user for MFA codes. Upstash when `UPSTASH_REDIS_REST_URL/TOKEN` are set, otherwise an in-memory limiter with a startup warning. If Upstash errors, attempts are allowed and logged (an outage must not lock shops out).

## Local vs hosted config

`supabase/config.toml` configures local dev only. For staging and production set, in the Supabase dashboard: Site URL, redirect URLs (`<origin>/**`), minimum password length 10, email confirmations on, TOTP MFA enabled, the three email templates from `supabase/templates`, and (when Google is on) the Google provider.

## Not built yet

Invite/accept flow for managers and cashiers, cashier PIN unlock (must never accept Google), org switcher for users in several orgs.
