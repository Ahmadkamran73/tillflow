# Tenders: cash, card on the shop's own terminal, split payment, tips

> **Vouchers were removed** (2026-10-09): a shop takes cash and card, plus exchange credit from a
> clothing exchange (step 2.2, not a tender type). Old voucher payments stay readable; the database
> checks that drop `voucher` are `NOT VALID`, so they bind new rows only, and existing Voucher
> tender types are archived.

Phase 2 · Step 2.1. Builds on the cash flow of step 1.5 and the outbox of step 1.6.
v1 has **no integrated card reader and no Stripe**: the shop takes the card on its own terminal and
Tillflow only records the tender. No card data ever reaches Tillflow.

## Rules

- **Tender types** are per location: `Cash` (built in, one per location, cannot be archived), plus
  any number of `Card` types the manager names (for example "Card - AIB terminal",
  "Card - SumUp"). Each location is seeded with Cash and Card. Types are archived, never
  deleted, because payments point at them. Settings > Payment types.
- **Balance.** The sale total `T` is the VAT-inclusive basket total before cash rounding. Card
  amounts are exact, each above zero, and together at most `T`: change is only ever given
  from cash. At most one cash tender per sale.
- **5c rounding applies to the cash share only, and only in shops whose preset says so**
  (`register.cashRounding5c`: general store and café yes; restaurant, electronics, clothing no). When
  it is off the cash share is taken to the cent. The flag is stored on the sale (`roundCash`) so a
  reprint or emailed receipt never changes. `settleTenders(total, tenders, { roundCash })`.
  Otherwise: `cashShare = T - card`;
  `rounding = cashRound(cashShare)`; `amountDue = T + rounding`; the cash taken must be at least
  `cashShare + rounding`; `change = cash - (cashShare + rounding)`. This does not depend on the
  order tenders were taken (so the server can recompute it), a card-only sale is never rounded, and
  a cash-only sale gives the same numbers as before. A cash remainder of 1-2c rounds to a zero
  cash amount, which is allowed. Cash comes last: it completes the sale.
- **Card.** The amount defaults to the exact amount left; the cashier may lower it to split. After
  the shop's terminal approves, the cashier taps "Approved on terminal". Optional reference (the
  terminal receipt or approval code), at most 40 characters, letters, digits, space, `-` and `/`.
  **Rejected if, with spaces, dashes and slashes removed, it holds 13 or more digits in a row**
  (a card number has 13-19 digits). It is enforced on
  the till (`tenderReference`), on the server (Zod), and in the database (`payments_provider_ref`).
- **Tips.** Only on card tenders, only in business types whose preset has `register.tips` (café,
  restaurant). Entered by the cashier, stored in `payments.tip_cents`, between 0 and the card
  amount. A tip is never part of the sale total, VAT or `amountDue`.
- **Void.** Before completion any added tender can be removed ("Remove"); removing a card tender
  reminds the cashier to void it on the terminal too. Payments taken so far are kept (IndexedDB
  `meta.tenderDraft`) for the exact same cart. The sale in progress itself is kept in IndexedDB
  (`meta.currentCart`), so a reload, crash or sleeping tablet restores the cart and its payments
  (the till still locks on load). Both are deleted the moment the sale is saved to the outbox, so a
  finished sale can never come back and be rung up twice.
  After completion a sale is never edited: only refunds (step 2.2).
- **Offline.** Every tender works fully offline. The sale is saved in the outbox with its list of
  tenders; the receipt prints from it. The server re-prices and re-settles on sync.

## Data

- `tender_types` (org_id, location_id, method, label, sort, archived_at). RLS: members read,
  managers insert and update (label, sort, archived_at only), no delete. A trigger refuses
  archiving cash; a unique index allows one cash type per location. Seeded by a trigger on
  `locations` insert; existing locations backfilled in `0026`.
- `payments`: new `tender_type_id` (composite FK) and `label` (snapshot of the type's name);
  checks: amount >= 0, change only on cash, tip only on card and <= amount, `provider_ref`
  length and card-number check. Append-only, as before.
- `ops.record_sale` takes `payments` (1 to 10) and checks in SQL: at most one cash, the amounts add
  up to `amount_due`, tendered less change equals the amount, every `type_id` belongs to the sale's
  location and matches the method. Any failure raises `22023` (a rejection, never a retry).
  The old single `payment` shape still works.
- `public.tender_totals(org, from, to)` (security invoker, managers only): payments, amount and
  tips per payment type. Sales page shows "Today by payment type" so the owner can compare the card
  total with the terminal's end-of-day report. (Z-report groundwork.)
- `ops.device_tender_types(token_hash)`: the location's types and the shop's business type, for the
  catalogue feed and for sale sync (through the device token, never the payload).

## Wire format and sync

`syncSale.tenders`: 1-10 of `{ id, typeId | null, method, amountCents, tipCents, reference? }`,
at most one cash. Cash `amountCents` is what was handed over; card is what it
settles. A sale queued before this step (`tenderedCents`) is read as one cash tender, so old outbox
rows and held rejections still work. The till's `label` stays on the device.

The server (`src/lib/sync/process.ts`) prices the basket, runs `settleTenders` (`src/lib/money`),
and compares `amountDue` with the till's `expectedDueCents` (within 1c). New rejection reasons:
`tender_mismatch` (payments do not add up, tips where the shop takes none, tip above the card
amount) and `unknown_tender` (a type that is not this location's, or the wrong method); a payment
that does not cover the amount is still `short_tender`. A reference that failed validation is
removed from any stored rejection payload.

## Rounding mode on the wire

`syncSale.roundCash` (default true) carries the mode the sale was rung up with. The server prices with
the sale's own mode, not the shop's setting at sync time, so switching business type while sales are
queued cannot reject or mis-record them (rounding is at most 2c on the cash share and never touches
VAT). The emailed-receipt request carries it too. The saved sale in progress (`meta.currentCart`) is
dropped after 12 hours, malformed carts are ignored, and the age check is asked again on restore.
The cart and draft are deleted inside the same Dexie transaction as the outbox write.

If the sale's mode differs from the shop's current preset the sale is still accepted as rung up and is
saved with the review flag `rounding_differs` (the same mechanism as `vat_differs` / `old_prices`), so a
manager sees it in the sales review list.
`roundCash` must be a real boolean; the server always computes the amounts itself.

## Known limits

- The card amount is what the cashier types; the control is the owner comparing the card total
  with the terminal's report. A card voided on the till must also be voided on the terminal.
- No tip-sharing report yet (Tips and Gratuities
  Act report later).
- Tender types cannot be reordered in the back office yet (they sort by creation order).
- Refunds of split payments are done in step 2.2 (`docs/specs/refunds.md`): the cashier chooses the legs, each method up to what it took, and exchange credit is a fifth kind of payment (`exchange`) on the new sale.
