# Refunds, voids and exchanges

Phase 2 · Step 2.2. Builds on tenders (2.1) and the offline outbox (1.6). Decisions made with the
owner on 2026-10-08.

A completed sale is never edited. A correction is a new record that points at the sale: a
**refund** (some lines back), a **void** (the whole sale reversed), or an **exchange** (goods back
as credit towards a new sale). Money is integer cents; every amount goes through `src/lib/money`
(`refund.ts`); the server recomputes all of it.

## Rules

- **Find the sale.** Scan the barcode on the receipt (`TF` + the sale id, Code 128, printed by
  ESC/POS printers), pick from the 12 most recent sales on the till, type the receipt number
  (this till's), or, in shops with serial prompts (electronics), type a serial / IMEI. The till
  holds its own sales for 30 days, so it can find them offline; another till's sale, an older sale,
  or a serial on the server needs a connection (`GET /api/v1/register/sales/lookup`, paired
  device only, this shop only, no customer data, 30 lookups a minute).
- **Choose lines and units.** Each sale line has `qty - already refunded` units left. A Re-turn
  deposit goes back with its item. Each line has a "put back in stock" switch (default on).
- **Reason is required**: changed their mind, faulty, wrong item, damaged, rung up by mistake
  (voids), or other (a note is then required, 200 characters).
- **VAT is reversed at the ORIGINAL line rate.** A line gives back its share of the stored gross
  and VAT: after `k` of `qty` units are back, a line has returned `round_half_up(total * k / qty)`;
  a refund is the difference to what earlier refunds returned. Gross and VAT are done separately,
  net = gross - VAT. So any sequence of partial refunds adds up **exactly** to the original line,
  the last unit takes the rounding remainder, discounts stay as they were sold, and a line sold at
  13.5% in June is still 13.5% when refunded in August. No rate is ever looked up again
  (`refundLine` in `src/lib/money/refund.ts`; `ops.record_refund` repeats the rule in SQL).
- **Pay-back (the cashier chooses).** Each method may give back at most what it took on the
  sale, less earlier refunds by it (`availableOf`): a card sale can never be paid out in cash. Card
  and voucher amounts are exact; **only the cash leg is rounded to 5c** (shops whose preset
  rounds), and cash is always the remainder. The till pre-fills card first, then voucher, cash last.
  Cash may stray 2c above what the cash took, for rounding, **per refund so far** (each refund
  rounds its own cash share, so the drift adds up and the last refund is never stuck). Exchange
  credit that paid for the sale goes back as a **voucher, never as cash**: it may stand for a card
  payment on an earlier sale, and cash back would turn that card sale into a cash payout.
- **Card refunds** are done on the shop's own terminal first; Tillflow records a card refund
  against the card type with an optional reference (never a card number: 13+ digits are refused on
  the till, in Zod, and in a database check, as for sales). A voucher refund means a new paper
  voucher is handed over.
- **Tips** are not refunded, except on a **void**, which returns the card tip too (cafés and
  restaurants), and never more than the sale took.
- **Manager approval.** A refund needs a manager when it is a void, or when its value
  (items + deposits, before credit and rounding) is **above the shop's Refund approval limit**
  (Settings > Refund approval limit, owner only, default €20.00, audit-logged). The limit counts
  what earlier refunds of the same sale already gave back, so a big sale cannot be refunded a
  little at a time to stay under it. The till asks a
  manager or owner for their PIN; online, the server checks it and issues a single-use `refund`
  approval (30 minutes, one till) which the refund spends. How it was settled is stored on the
  refund (`approval_state`) and shown in Sales > Refunds:
  `not_needed` (under the limit), `verified` (server-checked PIN), `self` (a manager or owner
  was serving: the till's word), `unverified` (offline: the till names the manager whose cached
  PIN hash it checked). **A cashier who offers none of these is refused** and the refund waits in
  Needs attention. `self` and `unverified` are recorded (offline over-limit refunds keep working)
  but **not proven**: each one also opens an item in **Needs attention** (`refund_unverified`,
  "this refund WAS recorded ... ask the cashier and the manager") that a manager closes with a
  note, and Sales > Refunds shows it as "Not verified" next to who rang it.
- **Who is serving is proven by a server-signed token** (migration `0031`). When the unlock route
  has checked a PIN it asks the database to sign a "serving as" token: the person, the shop, the till,
  one hour (HMAC-SHA256 with a key that lives only in the database, `ops.signing_keys`, generated per
  environment). The till keeps it in memory only and sends it with a refund (`servingToken`) and in
  the `x-serving-token` header of the sale lookup. `ops.record_refund` and `ops.device_find_sale`
  verify it themselves: signature, this shop, this till, valid when the refund was made (so a refund
  made offline within the hour is still proven when it syncs), not more than a day past expiry on the
  server's clock (no indefinite replay), and the person still staff. A token for someone other than
  the named cashier is refused. A manager or owner with a valid token who needs an approval is
  `verified`. No token, an altered or expired one, or one for another till or shop proves nothing
  and the refund falls back to `self` / `unverified`: still recorded, shown as "Not verified" and
  sent to Needs attention, never silently trusted. A manager's approval of someone else's refund
  stays the single-use `register_approvals` row below (server-issued, bound to a sale and a value).
  The token is also tied to the till's current pairing (pairing again ends every token), is dropped
  from the device once the server has judged the refund it travelled with, and is never kept in a
  rejection. **Accepted, reviewed trade-off (owner decision, 2026-10-08):** a manager serving at the
  till does NOT need a second PIN or an approval row for an over-limit refund. The token stays
  scoped to one person, one shop and one till (never usable across tills) and to its validity
  period; every such refund is auditable: the refund row records the proven manager as approver, and
  the audit row records the serving manager, the till, the till's time and the server's time, and
  the verification status. **Residual:** it is a bearer credential for up to an hour (a day more for a refund made
  offline): someone who copies a manager's live token from the paired device could, within that
  window and on that till only, record over-limit refunds as `verified`. Per-method caps, the void
  rules and the audit log still apply; making each over-limit refund need its own approval row would
  close it, at the cost of the owner's rule that a manager at the till needs no second PIN.
- **An approval is for one sale and one value.** The unlock step sends the sale id and the refund's
  value with the PIN; the server issues a single-use `refund` approval bound to that sale and
  that amount (`register_approvals.sale_id`, `max_cents`). A refund spends it only for that sale
  and only up to that value; an approval with no sale is not accepted for a refund.
- **Void.** Only a whole sale, from the **same till on the same shop-local day** (and within 48
  hours on the server's own clock), with nothing refunded before. It always needs a manager. A
  refund can never be dated before its sale. It is a refund row with `kind = 'void'`.
- **Finding a sale is scoped to the person serving.** The lookup names who is serving: a
  cashier finds sales of **this till** and their own, a manager or owner any sale of the shop; the
  person must belong to the shop. No cashier ids are returned. (Who is serving is still the till's
  claim, see the limits.)
- **Exchange** (clothing, `exchangeFlow`). With the new items already in the cart, Refund >
  pick the returned lines > "Exchange for other items". The credit is `min(returned value, cart
total)`; if the returned value is more, the rest is paid back by the legs above. The refund is
  worked out (`kind = 'exchange'`, `credit_cents`, the new sale's id), then the payment screen
  opens with an "Exchange credit" payment that cannot be removed. **Nothing is recorded until the
  sale is complete**: the refund and the sale are then saved together in one transaction
  (`completeExchange`), so an exchange never half exists on the device. "Cancel exchange" (on the
  banner) simply discards the draft. The new sale is paid with the credit
  (`payments.method = 'exchange'`, `exchange_refund_id`). If the server later refuses the refund,
  the sale that waited for it is marked rejected on the till instead of blocking the queue. A credit can pay for one sale only.
  Items dearer than the credit: the customer pays the difference with the usual tenders.
- **Never edits the original.** `refunds`, `refund_lines` and `refund_payments` are append-only
  (triggers refuse UPDATE, DELETE and TRUNCATE, as for sales); clients can only SELECT.
- **Stock.** Each restocked tracked item adds a `stock_movements` row, reason `refund`, `ref_id` =
  the refund id.
- **Offline.** A refund of a sale held on the till works with no connection. It is saved in
  IndexedDB (Dexie v6 `refunds`), numbered in the till's own series (`Till 1 · R000003`), the
  receipt prints, and it syncs after the sales (`POST /api/v1/sync/refunds`). A refund waits while
  the sale it refunds is still queued; an exchange sale waits for its refund. The server may
  answer `retry` (the original has not arrived); after 7 days that becomes a rejection.

## Data

- `refunds` (id = idempotency key, original sale, kind, reason, per-till `receipt_seq`, totals,
  `credit_cents`, `cash_rounding_cents`, `amount_cents`, `approval_state`, approver, approval id,
  `exchange_sale_id`), `refund_lines` (the original line's rate copied across, net/VAT/gross, qty,
  restock), `refund_payments` (method cash/card/voucher/exchange, type, label snapshot, amount,
  tip, reference). All with `org_id`, RLS (managers read all; a cashier reads their own refunds),
  composite foreign keys, check constraints on the sums.
- `payments.method` also allows `exchange`; `payments.exchange_refund_id` (unique).
- `organisations.refund_override_cents` (default 2000), changed only through
  `public.set_refund_override` (owner, audited).
- Functions (SECURITY DEFINER in `ops`, callable only by the app's privileged module):
  `record_refund` (one transaction; locks the sale; recomputes every line and checks every sum,
  method cap and the void rules; spends the approval; writes the rows, stock and audit),
  `device_find_sale`, `device_refunds_known`, `device_refund_meta`; `record_sale` replaced to
  accept the exchange payment (answers `exchange_pending` until the refund exists).
  `public.refund_totals` gives refunds per payment type for managers (Sales page, and the Z-report
  in 2.3).

## Wire format

`syncRefund` (`src/lib/sync/refund-protocol.ts`): id, `originalSaleId`, kind, reason, `lines`
(`lineNo`, `qty`, `restock`: server row ids are unknown to an offline till, so lines are named by
their position on the sale), `legs`, `creditCents` + `exchangeSaleId` (exchange only), `roundCash`,
`approvalId` / `claimedApprover`, `expectedAmountCents` (compared within 1c, never trusted).
New rejection reasons: `refund_exceeds`, `refund_mismatch`, `refund_needs_approval`,
`void_not_allowed`, `original_not_found`. Refund rejections appear in Needs attention without a
"Try again" button; a manager marks them resolved with a note.

## Known limits

- **Approval can be unproven.** A manager's PIN cannot be checked by the server while the till is
  offline, and who is serving is the till's claim (the same limit as the cashier on a sale). Such
  refunds are recorded, flagged "Not verified" in Sales > Refunds, and never silently trusted;
  a cashier with a paired device could forge a `claimedApprover` and the owner would see it only
  there. A stricter rule (refuse every over-limit refund that has no server-issued approval)
  would make over-limit offline refunds impossible; revisit with the owner.
- **Offline, nothing can be proven.** A till unlocked offline has no signed token, so a cashier
  with a paired device could still name a manager as the cashier (`self`) or as approver
  (`unverified`); both are recorded as "Not verified", shown with the cashier in Sales > Refunds and
  sent to Needs attention. A token lasts an hour; one made offline within it is proven on sync.
- A synced sale is refunded from the till's own copy when picked from the recent list (the server
  copy replaces it when found by search); a 1c difference in the sale's total is accepted by the
  server, but VAT that was flagged `vat_differs` would make the refund amount differ by a cent.
- The card amount is what the cashier types; the Z-report comparison is the control. A card
  refunded on the till must also be refunded on the terminal.
- Tips are not refunded except on a void. Vouchers have no balance. Browser-print receipts show the
  sale code as text, not a barcode: scanning needs an ESC/POS printer (USB or network); everything
  else can be found by receipt number or the recent list.
- Rounding the cash leg per refund can leave the cash given back a few cents different from the
  cash taken over several partial refunds (each refund is rounded on its own).
- A sale rung before this step has no barcode; use the receipt number.
- An over-refund from two tills at once is caught by the server (the sale row is locked) and lands
  in Needs attention; the cash has already been handed over.
- Refunds do not yet appear on a Z-report or shift (Step 2.3), nor in VAT reports (Phase 2 reports).
