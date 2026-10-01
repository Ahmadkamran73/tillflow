# Tillflow POS security rules

Tillflow is a multi-tenant SaaS: many shops share one Postgres database. A cross-tenant leak is the worst possible bug. Flag violations of these rules as high severity.

## Multi-tenant isolation

- Every business table has `org_id`, RLS enabled and a policy. A new table without RLS, or a policy using `using (true)`, is a finding.
- Policies must use the single shared SQL helper for the current user's orgs, not ad-hoc subqueries.
- Every query on a business table must be scoped by `org_id`. `org_id`, `location_id`, `register_id` and user ids must come from the verified session or device token, never from a request body, query string, header or form field.
- Loading a record by a client-supplied id without checking it belongs to the caller's org is an IDOR. Flag it.
- Privileged database access (the service-role key, a service client, or the `JOBS_DATABASE_URL` connection, which must log in as the least-privilege `tillflow_ops` role, never `postgres`) is allowed ONLY in `src/lib/ops/db.ts` and the pg-boss job handlers (`src/lib/jobs`). `src/lib/ops/db.ts` may only call `ops.*` SECURITY DEFINER functions, never touch a table, and must keep `import "server-only"`. Anything else importing it, or using the key, is a finding (`pnpm check:imports` fails CI). It must never appear in `NEXT_PUBLIC_*` variables or client bundles.
- `security definer` functions must set `search_path` and check the caller's org.
- Exports, search, caches, storage paths and realtime channels must be scoped per org. Uniqueness (SKU, barcode, receipt number) is per org.

## Input, auth and SQL

- Every server action and route handler validates input with Zod and checks the caller's role (owner / manager / cashier) before acting.
- Never execute user-supplied SQL. Imports are parsed as CSV/Excel/JSON and mapped to typed columns. Raw SQL with string concatenation or interpolation of user input is a finding.
- Export cells starting with `=`, `+`, `-` or `@` must be escaped (formula injection).
- Auth calls go through `src/lib/auth` only.

## Money rules

- Money is integer cents. All VAT and rounding go through `src/lib/money`. Inline VAT maths, floats or `toFixed` on money are findings.
- The server recalculates every price, discount, VAT and total. Trusting client-sent totals or prices is a high-severity finding.
- Completed sales, lines and payments are never UPDATEd or DELETEd; corrections are refund/void rows. Refunds, large discounts and no-sale drawer opens need a manager role and an audit-log entry.
- No card numbers, CVV or track data are ever stored or logged. The Card tender stores only the amount and an optional terminal receipt reference typed by the cashier.

## PIN and device rules

- Cashier PINs are hashed with Argon2, compared in constant time, and never logged, returned to the client or stored in plain text. Failed attempts are rate-limited with lockout after 5 failures.
- A PIN only works on a paired device. Pairing uses one-time codes; device tokens are random, stored only as hashes (`device_token_hash`), revocable, and scoped to one register and org.
- Manager overrides are audit-logged with actor, action, entity and before/after.

## Secrets and privacy

- No hard-coded secrets, keys, tokens, passwords or connection strings in source, tests, docs or migrations. Secrets live in environment settings only.
- Never log personal data (names, emails, phones, addresses, VAT numbers, PINs, tokens, request bodies containing them). Errors go through `src/lib/errors` (allow-list scrubber) before they are logged, stored in `error_events` or emailed.
- Service-role, database URLs and production credentials must never be used by tests or dev tooling.
- Rate-limit auth, PIN, sync and export endpoints.
