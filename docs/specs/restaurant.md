# Restaurant flow (Phase 2, step 2.6)

Table service for `business_type = restaurant`: floor plan, tables, tabs, seats and courses,
kitchen/bar tickets by course, split bills, a service charge, tips, move/merge, all offline.
Builds on the café step (modifiers, allergens, station tickets, tips) and the sale/outbox/shift code.

## Decisions (owner, 2026-10-10)

- **Tabs are per till.** A tab belongs to the till that opened it (IndexedDB). Two tills do not share
  a table. Tab events sync to the server as an append-only log.
- **Service charge is part of the supply.** A per-shop percentage (0 to 25%, default 0) of the eat-in
  bill after discounts, taxed at the rate of each item it is charged on, shown as its own receipt line.
  Never on take-away, deposits or quick sales. This is the standard Irish treatment: a compulsory
  service charge is part of the consideration for the supply, so it follows the rate of what it is
  charged on and is apportioned across rates on a mixed bill; a voluntary tip is outside VAT and is
  stored beside the card payment. Shops must also display how tips and service charges are shared
  (Tips and Gratuities Act 2022): a shop notice, not till logic. Routine accountant sign-off before go-live.
- **Floor plan** is edited in the back office on a grid with drag and keyboard moving.

## Principle

A tab is a working document. It never holds money. Every bill (or part of a split bill) is paid as an
**ordinary sale** through `completeSale` -> outbox -> `ops.record_sale`, so completed sales stay
immutable and VAT, tenders, tips, shifts, stock, refunds and Z-reports are reused unchanged. The
server recalculates every price, VAT amount and the service charge.

## Data

- `floors`, `restaurant_tables` (grid x/y/w/h, seats, shape). Written only by
  `public.save_floor_plan` (managers/owners; SECURITY DEFINER with a role check, audit row). Never
  deleted, archived. Clients have SELECT only. Live names unique per floor; live tables never overlap.
- `tab_events` (append-only, written only by `ops.record_tab_event` with a device token). Kinds:
  open, send, fire, transfer, merge, close, void. `detail` is rebuilt in SQL from an allow-list
  (table name, covers, course, line count, from/to, parts, merged tab): no personal data.
- `sale_tabs` (append-only): the tab a NEW sale was paid from, written by the `ops.record_sale`
  wrapper (replays cannot attach one). Spend per cover = sales linked to a tab / covers on its `open`.
- `organisations.service_charge_bp` (0..2500), set by `public.set_service_charge` (owner, audited).
- `sales.review_flags` gains `service_differs`: the sale carried a different charge than the shop has
  now (a changed setting, or a till leaving it off). Saved, not refused.
- Migrations: `0038_restaurant` (generated), `0039_restaurant_rls_and_functions` (hand-written).

## Service charge in the money library

`calculateBasket({ serviceChargeBp })` adds one extra taxed line per VAT category with index
`lines.length + n`, after discounts, for eat-in lines only. The charge is `bp` of the eat-in grosses,
rounded half-up once, shared over the lines by largest remainder (`serviceChargeShares`), then grouped
by category and split with `splitVat` at that category's rate. It is stored as ordinary **item** sale
lines (no variant, quantity 1, no discount), so `ops.record_sale_core` and its SQL sum checks are
unchanged, a refund can take it back like any line, and shift and VAT reports include it. `Cart`
carries `serviceBp`; the wire sale carries `serviceChargeBp`; the server prices with the sale's own
value. Owner review wanted: `src/lib/money/service.ts`, `basket.ts`.

## Till

- Dexie v8: `tabs`, `tabEvents`. Cart lines may carry `seat`, `course`, `sentAt`; a sent line is never
  changed or removed (the reducer ignores it).
- **Table map** (`table-map.tsx`): floors as grids; each table shows status as icon + text:
  free, seated, ordered, bill. Tap a free table: guests (covers) then the order. A table with several
  bills asks which. "Quick sale" sells without a table (no service charge).
- **Order:** pick the seat and the course (1 to 4) before adding items.
- **Send** prints a kitchen/bar ticket (existing station routing) for unsent lines of the released
  courses (course 1 plus anything already fired). **Fire next course** releases the next course that
  has lines. Held lines say so. Tickets show the table, course, FIRE and seats, never amounts.
  Anything still unsent when the bill is paid is printed then, so nothing is missed.
- **Bill** asks for the bill and opens **Split**: by seat, by item (up to 6 bills), or evenly.
  By seat/item replace the tab by one tab per part (same table, same root id), each paid on its own
  as a normal sale with its own receipt, cash or card, and tip on card. A fixed-amount discount
  cannot be shared between bills. Each part is priced on its own, so its service charge and any percentage
  discount round separately: the parts can differ from the whole bill by up to a cent per part. Evenly keeps
  one sale and takes it in several payments (the split-tender screen shows each share); one receipt.
- **Move** a tab to a free table, or **merge** into a table with an order (lines and guests move; the
  source goes). Not allowed on a split bill. **Release table** closes an empty tab.
- Tabs live in IndexedDB and survive a reload, offline and lock. Closed tabs leave the device after a day.

## Sync

`POST /api/v1/sync/tabs` (device token, Zod strict, 60/min, 64 KB): per-event recorded / duplicate /
rejected; a rejected event stays flagged on the device and is never retried. Tab events are sent after
the sales, refunds and register events, so no sale ever waits for one. Sales gain `serviceChargeBp`
and `tabId` (a link only).

## Back office

- Settings > Floor plan (managers/owners): floors, tables (name, seats, shape, size), drag or arrow
  keys, announced moves, explicit Save. Settings > Service charge (owner).
- Dashboard tiles Covers and Spend per cover from today's tabs (`public.tab_covers`).

## Known limits

- **Partial refund of the service charge** is pro rata: the charge is stored as one line per charged
  item, right after the item (and its deposit), with the item's quantity and rate, so returning k of
  an item's units returns k/qty of its charge by the same cumulative maths as the item (the refund
  screen pairs them; the receipt adds the lines of one rate together). Refunds add up to the sale
  to the cent. No SQL change was needed. A till could still refund an item without its charge
  (under-refund only).
- **The till names the charge percentage** on a sale (offline sales must not be rejected when the
  setting changes). A value different from the shop's current one is saved and flagged
  `service_differs` for a manager, not refused. Merging tabs opened under different settings keeps
  the target's percentage.

- Two tills do not share tabs (per-till decision). A second till cannot see another till's open table.
- A line sent to the kitchen is taken off only with a manager PIN (Void): a cancellation ticket prints and an audit row (`tab.void_item`, verified or unverified_offline) is written.
- Split bills are exact: parts carry their share of the whole bill's discounts and service charge in whole cents (`serviceChargeCents`, server accepts within 1.5c of the percentage). VAT is worked out on each part's own receipt.
- A split bill cannot be moved or merged; splitting again is not supported.
- Evenly gives one receipt, not one per payer.
- Cash rounding applies to each cash payment of a bill as usual; per-bill rounding can differ by 5c.
- The service charge is not shown on the kitchen ticket by design; cashiers cannot change it.
- Not tested: real kitchen printers, a tablet with soft keyboard, a screen reader, drag on touch.
