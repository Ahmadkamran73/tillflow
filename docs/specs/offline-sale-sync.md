# Offline sale sync (Phase 1 · Step 1.6)

## Summary

Every completed sale is written to the device's Dexie outbox first (UUIDv7 id = idempotency key) and the receipt prints before any network call. A background drain (service worker via Serwist, plus an in-page fallback) posts sales in order to `POST /api/v1/sync/sales`. The server authenticates, validates with Zod, recalculates totals and VAT with `src/lib/money`, rejects mismatches over 1c, and writes sale, lines, payment and stock movements in one transaction, idempotent on replay. Rejected sales go to a manager's "Needs attention" list, never dropped. Implements docs/PLAN.md section 9.

## Out of scope

- Device tokens, pairing and PINs (step 1.7). Until then the endpoint authenticates the signed-in member's session plus a register id that belongs to the org, all behind `authenticateRegister()` so 1.7 swaps in the token.
- Card, split and voucher tenders (2.1), refunds (2.2), shifts (2.3), customers (2.5).
- Syncing a VAT invoice issued after the sale has synced (stays device-only; a later `sale_invoices` table).
- Realtime nudges for catalogue changes (existing 60 s pull stays).

## Screens

- **Register status pill** (all roles): `Online`, `Offline (n waiting)`, `Syncing`; icon + text. Waiting count comes from IndexedDB, so it survives a reload.
- **Offline warning banner** (register): shown when the oldest unsynced sale, or the last successful sync, is over 24 h old. Text only plus icon, `role=status`.
- **Rejected notice** (register, cashier): "n sale(s) sent to a manager" when any local sale is `rejected`.
- **Needs attention** `/o/<orgId>/sales/attention` (owner/manager; others 404): list of open rejections with time, till, receipt number, plain-language reason, till total vs server total, items. Actions: **Try again** (reprice now), **Mark resolved** (note required). Empty state: "Nothing needs attention". Dashboard tile shows the open count and any till not seen for over 24 h.

## Data

All tables have `org_id`, RLS, composite `(org_id, id)` FKs. Migrations 0018 (generated) and 0019 (hand-written RLS/functions).

- `sales` (append-only): `id` = device UUIDv7, `register_id`, `location_id`, `receipt_seq` (unique per org+register), `mode`, `completed_at` (device clock, audit), `received_at`, `priced_as_of`, `cashier_user_id`, totals (`items_total_cents`, `vat_cents`, `non_vat_cents`, `cash_rounding_cents`, `amount_due_cents`), `client_due_cents`.
- `sale_lines` (append-only, the rate snapshot): `sale_id`, `line_no`, `kind` (item|deposit), `variant_id`, `product_id`, `name`, `qty`, `unit_price_cents`, `modifiers` jsonb, `discount_cents`, `tax_category`, `tax_rate_bp`, `net_cents`, `vat_cents`, `gross_cents`, `serial`.
- `payments` (append-only): `sale_id`, `method='cash'`, `amount_cents`, `tendered_cents`, `change_cents`, `tip_cents=0`.
- `sync_rejections`: `id` = sale id, `register_id`, `reason`, `detail` jsonb, `payload` jsonb (cart inputs only), `status` open|resolved, resolve fields. Managers read; written by `ops.*`.
- `variant_price_history`, `modifier_price_history` (append-only, trigger-filled, backfilled): let the server price a sale at the catalogue in force when it was sold, so a price edited while a till was offline does not reject its sales.
- Stock: one `stock_movements` row per tracked variant per sale (`reason='sale'`, `ref_id` = sale id). Negative stock is allowed and reported, never blocked.
- Idempotency: `sales.id` primary key; replay returns `duplicate` and writes nothing.

Device (Dexie v3): `sales` gains `syncState` (pending|synced|rejected), `attempts`, `nextAttemptAt`, `expectedDueCents`, `catalogAsOf`. Rows are removed only after server confirmation plus 30 days.

## Rules

1. Device: `completeSale` stores the sale (state `pending`) in one transaction, then the receipt prints; sync starts afterwards and never blocks the UI.
2. Drain: single drainer per shop (`navigator.locks`), oldest first in batches of 25. `created`/`duplicate` → `synced`; `rejected` → `rejected` and the queue moves on; network/5xx → stop, exponential backoff 2 s → 5 min with jitter; 401/403 → "signed out" state, nothing lost.
3. Server per sale: Zod-validate (a bad sale is rejected alone); `completedAt` within [now − 90 d, now + 10 min]; price from the as-of catalogue via `priceSaleOnServer` (prices, VAT category, deposits from the server, rates by the sale's own shop-local date); fall back to the device's `catalogAsOf` if the first pass differs; reject when `|server due − expectedDueCents| > 1` or tender < due. Lines are mapped from `basket.vatLines` with no maths of their own.
4. Receipt numbers: unique per register; a clash with a different sale id is rejected `receipt_number_used`. The catalogue feed returns each till's last server sequence so a cleared device continues after it.
5. Writes go through `ops.record_sale(p, p_token_hash)` (SECURITY DEFINER, executable only by the privileged role), which re-checks membership and that the register is in the org, that the till's device token (when given; only the back office's Try again passes none) belongs to that org and register, and every sum: per item line net + VAT = gross, item gross = items total, item VAT = VAT, deposit gross = non-VAT, cash rounding in [-2, 2], due = items + non-VAT + rounding, payment = due, change = tendered - due (else 22023, a rejection). Sales are saved but flagged for a manager's review (`sales.review_flags`, Sales > To review, dashboard) when the till's printed VAT (`expectedVatCents`, stored as `client_vat_cents`) differs from the server's by more than 1c (`vat_differs`), or when a sale synced over an hour late was priced at an older catalogue and today's total would be higher (`old_prices`, a till clock set back). Mark reviewed writes a `sale.reviewed` audit row; the sale itself never changes. Clients have no insert/update/delete on sales tables; triggers block UPDATE/DELETE for everyone.
6. Reason codes: `invalid`, `unknown_item`, `modifier_not_offered`, `price_mismatch`, `short_tender`, `bad_time`, `receipt_number_used`, `cannot_price`.
7. Try again reprices at the current catalogue and records the sale under its original cashier; Mark resolved needs a note. Both audit-logged. Manager role, aal2.
8. Rate limit 120 requests/min per user (in memory); body ≤ 256 KB; ≤ 25 sales per request.

## Edge cases

- Offline for days; browser reload while offline (service worker serves the cached register shell; outbox persists).
- Double submit, two tabs, SW and page draining together (lock + idempotent server).
- Response lost after the server committed: replay returns `duplicate`, device marks synced.
- Price changed or product archived while offline: history lookup; archived products still priceable.
- Sale around midnight or a VAT rate change: priced by the sale's own date.
- Device clock wrong: `bad_time` rejection, shown to a manager.
- Negative stock after offline trading: allowed.
- Mixed batch: one rejected sale never blocks others.
- GDPR: no customer data in sales or `sync_rejections.payload` (invoice details excluded).

## Security and privacy

- Cross-tenant: org from the URL/body is checked against membership; register must belong to the org; catalogue rows loaded through RLS; `ops.record_sale` re-verifies. Other-org ids return `unknown_item`/404.
- Totals are never trusted; client values are kept only as audit fields.
- Privileged DB access only via `src/lib/ops/db.ts` calling `ops.*` functions.
- Never logged: sale contents, serials, emails. Errors carry reason codes only.

## Acceptance tests

1. (unit) A malformed sale in a batch is rejected, others accepted.
2. (unit) Server due differs by 1c → accepted; by 2c → `price_mismatch`.
3. (unit) `sale-record` lines reconcile to basket gross, VAT and total.
4. (unit) Drain: oldest first; network failure keeps every row and backs off; rejected does not block; never deletes before confirmation; one drainer at a time.
5. (RLS) Shop B cannot read Shop A sales, lines, payments, history; cashier cannot read `sync_rejections`.
6. (RLS) No client can insert/update/delete sales; trigger blocks update/delete even for the owner role.
7. (RLS) `ops.record_sale`: not callable by `authenticated`; refuses another org's register or a non-member; replay returns `duplicate` with no extra rows or stock; receipt clash rejected.
8. (RLS) Price history rows appear on price change; as-of lookup returns the price in force.
9. (e2e) Go offline → 20 sales → reload → reconnect → exactly 20 sales on the server, stock = opening − 20.
10. (e2e) Re-posting the same 20 creates nothing.
11. (e2e) Price changed while offline: the offline sale syncs at the old price.
12. (e2e) Tampered expected total → appears in Needs attention → Mark resolved.

## Open questions

- Pilot price-drift tolerance: 30 days of `catalogAsOf`, 90 days of `completedAt` are assumed; confirm with pilot shops.
- Should cashiers see the reason a sale was rejected, or only that a manager was notified (currently the latter)?
