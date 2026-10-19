# Shifts, cash management, X- and Z-reports (Phase 2, step 2.3)

## Goal

A till trades in shifts. A shift opens with a float, records cash in/out with a note, and closes
with a counted drawer. The X-report (mid-shift, changes nothing) and the Z-report (at close,
immutable) show sales by tender, VAT by rate, refunds, discounts, tips, expected vs counted cash and
over/short. The Z is printed on the till and emailed to every owner.

## Decisions (owner, 2026-10-09)

- Offline-first: open, cash in/out and close are events in the till's outbox.
- Selling is blocked until a shift is open on that till. One open shift per till.
- The cashier sees the expected cash while counting (blind count is v2).
- The Z is emailed to all owners of the shop by a pg-boss job; a mail failure never blocks the close.

## Maths (`src/lib/money/shift.ts`, 100% covered)

expected = float + cash sales + cash in - cash out - cash refunds. over/short = counted - expected
(positive over, negative short). Cash sales are the stored cash `payments.amount_cents` (net of
change, including 5c rounding); cash refunds are cash `refund_payments`. Card and exchange credit
never touch the drawer. The SQL twin is `app.shift_report`; a test feeds both the same fixtures.

## Data

`shifts`, `cash_movements`, `shift_closes` (the immutable Z: report jsonb snapshot, `z_seq` per till,
counted, expected, over/short, review flags), `shift_documents` (links a sale or refund to its shift
without touching the append-only sale tables). All append-only, SELECT-only for clients, written
only by `ops.*` functions authenticated with the device token.

## Sync

Order on the outbox: shift open, then sales/refunds/cash movements, then close. The close waits until
every sale and refund of the shift is synced or rejected. Rejected ones are named on the Z.
The server recomputes the report; if it differs from the till's printed figures the close carries
`z_differs`; if the document counts differ, `counts_differ`.

## Known limits

- A sale accepted after its shift's Z (resolved later from Needs attention) is linked to the closed
  shift but is not in that Z; the back office shows it as added after close.
- The till prints the Z from local figures; the server's Z is authoritative.
- Cash in/out has no manager approval or limit yet.
- The Z number is assigned on the device (like receipt numbers).
- Blind cash-up, several drawers per till and per-cashier shifts are v2.
