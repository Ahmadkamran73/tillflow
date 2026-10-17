# Subscription billing by bank transfer (Phase 3)

PLAN.md section 14. One fixed monthly price for every business, paid by bank transfer, reconciled
by hand by the Tillflow super-admin. No payment provider is installed or called in v1.

## Decisions (owner, 2026-10-16)

- **Per business** (organisation), one subscription and one invoice a month. Changing to per shop
  later is a settings and invoice-line change.
- **VAT 23%**, taken from `BILLING_VAT_RATE` (a percentage such as `23`) and stored on every invoice, so a rate change
  never alters an invoice already issued.
- **Super-admin** = a row in `platform_admins` AND a two-step (aal2) session. Rows are added by a
  one-off SQL statement per environment; there is no screen for it.
- **Paused = read-only**: sales, refunds, shift opens and cash moves, customer saves, import
  confirmation and catalogue / stock writes are refused in the database (`TF004`). Reads, report
  downloads, the whole-account export and closing an already-open shift (so the day's Z can still
  be made) keep working. Nothing is ever deleted.

## Settings (environment; nothing has a default)

`BILLING_PRICE_CENTS` (ex VAT), `BILLING_TRIAL_DAYS`, `BILLING_GRACE_DAYS`,
`BILLING_INVOICE_DUE_DAYS`, `BILLING_VAT_RATE`, `BILLING_ACCOUNT_NAME`, `BILLING_IBAN`,
`BILLING_BIC`, `BILLING_VAT_NUMBER`, `BILLING_ADDRESS`, and optionally `BILLING_SUPPLIER_NAME` (the seller
named on the invoice; if unset it is the bank account holder). The two names may legitimately differ:
the invoice names the supplier, the payment instructions name the account beneficiary. Parsed once by Zod in
`src/lib/billing/config.ts` (IBAN mod-97 checked). If anything is missing or invalid the billing
jobs log the setting names and do nothing, and the owner page says the bank details are not
available. `.env.example` is write-protected for Claude: the owner adds the names. Playwright gives
the app fake values (the published example IBAN), never a real account.

## Flow

1. **Subscription row.** `ops.billing_ensure_subscriptions` gives every business without one a
   `trial` subscription and sets `organisations.trial_ends_at` (created + trial days; a business
   that already existed gets the full trial from the first run).
2. **Invoice.** Hourly job `billing-invoices`. When the trial has ended (or the next month has
   started), `nextPeriod` (`schedule.ts`) names the period; `bankTransferProvider.draftInvoice`
   works out VAT with `addVat` (`src/lib/money`) and a payment reference; `ops.billing_issue_invoice`
   takes the next number under a lock and stores it. Idempotent per (business, period). Only one
   unpaid invoice exists per business: the next month is not invoiced until it is paid.
3. **Email.** The PDF (our VAT number, `INV-000123`, VAT rate and amount, IBAN/BIC, payment
   reference) goes to every owner. `emailed_at` is stamped only after at least one address got it, so
   a failed send is retried the next hour and a partial send is not repeated.
4. **Reminders and pause.** Hourly job `billing-dunning` (`dunningState` in `period.ts`): from the
   due date the subscription is `overdue` and reminder 1 is owed; from due + 7 days reminder 2; once
   more than `BILLING_GRACE_DAYS` have passed since the due date, `ops.billing_pause` sets the
   organisation `read_only` and the subscription `paused`. A reminder is claimed in the database
   before it is sent and handed back if the send fails, so two workers never both send it and a
   job that was down still sends what is owed, once.
5. **Payment.** The super-admin matches the transfer in the bank and presses **Mark as paid**
   (bank reference and date required). The invoice becomes paid, the subscription active with the
   paid period, the organisation `active` (unpaused). **Unpause** (with a written reason) reopens
   a business without a payment and holds off re-pausing for N days.
6. **Statement CSV (optional).** The super-admin uploads a bank CSV; references are found, checked
   (check character), and looked up. Each is shown as exact match / amount differs / already paid /
   unknown / typo, with its own Confirm button that calls the same audited Mark as paid. The file
   is parsed in memory and never stored (10 MB, 5,000 rows, 10 uploads an hour).

## Payment reference

`TF-7K3Q-1126-K`: 4 random characters (no 0, 1, I, L, O), the invoice month and year, and a check
character (weighted sum mod 33 over a 33-symbol alphabet, weights coprime to 33 with neighbouring
differences coprime too). Every single mistyped character and every swap of two neighbours is
caught (tested exhaustively). TypeScript (`reference.ts`) and SQL (`app.billing_reference_check`)
agree (RLS test). The database refuses an invoice whose reference does not check.

## Data (migrations 0054 generated, 0055 hand-written)

`subscriptions`, `billing_invoices`, `billing_counters`, `platform_admins`. Owners read their own
subscription and invoices (SELECT only). Invoices are immutable (trigger: no figure, number,
reference or date change, no delete or truncate; issued can become paid or void once). Numbers
come from `billing_counters` under `FOR UPDATE` in the same transaction as the insert: no gaps, a
failed call uses no number (proved with 20 parallel calls). `platform_admins` and the counter are
deny-all to clients. Admin functions (`public.admin_*`) check `app.is_platform_admin()` first and
write `audit_log` rows holding ids and amounts only.

## Read-only enforcement

`app.org_writable(org)` (trial and active) and `app.org_accepts_at(org, at)` (also accepts a write
made before the pause, for a till that was offline). Wrappers in front of `ops.record_sale`,
`record_refund`, `record_shift_event` (open and cash only), `public.save_customer`,
`public.confirm_import`; restrictive RLS policies on `products`, `variants`, `variant_costs`,
`stock_movements`, `categories`, `modifier_groups`, `modifiers`, `product_modifier_groups`. The
renamed inner functions are closed to clients. Sync turns `TF004` into the rejection
`org_read_only`, so the sale is kept in Needs attention (not retried forever); once the account is
open again **Try again** records it. The till gets `readOnly` in its catalogue feed
(`ops.device_billing_state`), shows a notice and does not open the payment screen.

## v2 seam

`src/lib/billing/provider.ts` defines `BillingProvider` (`draftInvoice`, `paymentInstructions`) and
`getBillingProvider(config)`. Only the bank-transfer implementation exists. A card or direct-debit
provider adds methods there and calls the same database functions to mark an invoice paid.

## After the audits (tenant isolation, VAT, accessibility)

- Each invoice stores supplier name, address and VAT number and the customer name, address and VAT
  number as on the day (customer from the business and its first location). The PDF is drawn from
  those, so a reprint years later matches the original.
- The database requires VAT to be exactly net x rate rounded half up (not "within half a cent").
- A late-synced sale is accepted after a pause only if it was completed before the pause AND the
  pause is under 3 days old, so a till edited to back-date sales cannot keep trading.
- Owners read invoices through a column grant: no bank statement text, no admin id, no email stamps.
  The bank reference pre-filled from a statement is the invoice's payment reference, not the raw line.
- Read-only also refuses DELETE on the catalogue and stock tables. The inner functions behind the
  wrappers are closed to the jobs role. Pause and unpause take locks in the same order.
- Statement uploads are limited to 1 MB (the server-action body limit) and 5,000 lines.
- Managers see the read-only banner (it reads the business status, which every member can read).

## Paused businesses (owner decisions, 2026-10-17)

**Paused months are not billed.** Invoices already due before the pause stay payable. No invoice is
created while paused, and months that passed entirely while paused are never invoiced. When the
business is reopened (Mark as paid on a paused business, or Unpause) `subscriptions.resumed_on` is set
to that day; if it is later than the end of the last invoiced period, the next invoice period starts
on that day and the monthly cycle is counted from it. A reopening inside a period already paid changes
nothing. A business unpaused without paying keeps its unpaid invoice (still blocks new ones) and gets
the same rule when that invoice is paid. Months it traded while unpaused ARE invoiced. **Accountant to
review this policy.**

**What a paused business may change** (enforced in the database, not only hidden in the screens):

- Allowed: view reports and sales history, all report downloads, the account ZIP, invoices and PDFs,
  closing an already open shift, a person's own PIN and two-step settings, register events (drawer-open
  audit trail).
- Blocked (`TF004`): sales, refunds, shift open and cash moves, products, prices, stock, categories,
  modifiers, customers, imports, tender types, floor plan, service charge, discount and refund limits,
  new pairing codes, adding till staff, tab events, creating a customer at the till.
- Owner only while paused: revoking a till, removing till staff, setting or resetting a till PIN.
- Suppliers have no manual screen; they change only by import, which is blocked.
- Migration `0056` also blocks direct location and register changes and undoing an import while paused (an owner may still remove a till). Deliberately allowed: erasing a customer, withdrawing marketing consent (legal rights), marking a sale reviewed, and pairing with a code made before the pause (valid ten minutes).
- Known limit: a till can still claim an earlier `completed_at` to get a late sale accepted; bounded to 3 days after the pause. Closing it needs a last-sync column on the register.

## Open decisions and extra limits

- Register events (no-sale drawer opens) are still recorded while paused, as an audit trail.
- `admin_list_invoices` and `admin_match_references` read across businesses and are not audit-logged
  (the audit log is per business); marking paid and unpausing are.
- With under 7 grace days there is no second reminder. After a long outage the pause email is sent
  without the older reminders.
- Someone outside a business can learn whether it is paused by calling save_customer or
  confirm_import with its id (the error code differs); it needs the business id.

## Known limits (accepted, please confirm)

- Existing pilot businesses get a fresh trial from the first run of the job.
- Only a super-admin marks a payment; a payment without a recognisable reference is found by name
  and amount in the bank app, not by the matcher.
- A voided invoice has no screen yet (the status exists; its period is not re-issued automatically).
- Partial payments are not modelled: an invoice is paid or not.
- A sale made on a till that is offline after the pause is rejected when it syncs (it is kept for
  a manager); only sales completed before the pause are accepted late.
- Reminder and invoice emails go to every owner address; a bounce is not tracked.
- Invoice wording, VAT treatment of Tillflow's own supply, and our VAT registration need the
  accountant's confirmation before the first real invoice (PLAN.md section 14).
- Platform admin enrolment is manual SQL (below); there is no audit of who was added.

## Making someone a platform admin (one statement per environment)

Check the account first: find the user in the Supabase dashboard (Authentication > Users) or with
`select id, email, last_sign_in_at from auth.users where email = '<their email>';` and confirm the
id and that exactly one row comes back. Then, in the SQL editor of THAT environment only:

`insert into public.platform_admins (user_id) values ('<that id>');`

Verify: the person signs in with two-step verification and opens `/admin/billing`; anyone else gets
a 404. Remove with `delete from public.platform_admins where user_id = '<id>';`. Do it on local
first, then staging, and on production only when real invoices are to be handled. Never add an
account just to make a test pass; tests create their own throw-away admins.
- Pause and reminders use the Irish date at the time the hourly job runs (up to an hour late).
