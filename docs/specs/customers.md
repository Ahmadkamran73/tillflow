# Customers

Phase 2. Customers of a shop: created at the till or in the back office, linked to sales, with GDPR export and erasure.

## Decisions (defaults, 2026-10-10; change on request)

- **Link table, not a sales column.** `sale_customers (sale_id, org_id, customer_id)` is append-only; sales are never touched. `ops.record_sale` is wrapped again (`record_sale_shifted` is the 0033 shift wrapper).
- **Delete = anonymise.** `public.anonymise_customer` scrubs name, email, phone, VAT, address, notes and consent, sets `anonymised_at`, keeps the id so sales stay linked (6-year retention). Idempotent; one audit row.
- **Till is online-only for customers.** Search and create go through `/api/v1/register/customers` (paired device, 30/min) and `ops.device_customer_*`. Nothing is cached in IndexedDB; the till keeps the picked customer in memory and the sale carries only `customerId`. Offline: the dialog says it needs a connection; the sale itself is unaffected.
- **Roles.** Managers and owners read customers and links (RLS) and run save, consent, export and anonymise (functions check `app.manager_org_ids()`). Any paired till can create, and search by NAME only (2+ chars, 8 rows, returns id, name and a masked hint such as `j***@example.com` or `ends 567`, never full contact details; from the tenant audit). Cashiers have no table access.
- **Consent** is an explicit tick (default off); the timestamp is the database clock, withdrawing clears it. All audited, with ids only (no names/emails in `audit_log`).
- **Export** one customer as JSON or CSV (`/o/<org>/customers/<id>/export`), 5 per hour per user (`export` bucket), audited per call. CSV cells starting `= + - @` get a leading apostrophe (`src/lib/csv.ts`).
- **VAT number** is checked like a VAT invoice (`customerVatNumber`: Irish mod-23 or EU shape) in Zod; the database checks the shape only.

## Known limits

- A sale for a customer unknown, from another shop, or anonymised meanwhile is recorded unlinked, silently (no review flag).
- The VAT invoice at the till is not prefilled from the customer (addresses are not sent to tills).
- A paired till can create customers without a person's PIN; a cashier can list customer names of the shop (2+ character sweeps, 30/min per till, in memory) but not contact details.
- A sale links to its customer only when first recorded (a replay cannot attach one later).
- Export is a GET with a side effect (audit row, rate-limit spend): a cross-site link could trigger it but not read it. A client-chosen customer id that collides in another shop answers 409 "email taken" (confirms nothing readable). Till-created customers have no actor in `audit_log`.
- No full-account ZIP export, bulk delete, import, marketing lists or per-customer notes visible at the till.
- Purchase history shows the latest 100 sales, with no refund netting.
