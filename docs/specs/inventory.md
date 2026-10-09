# Inventory

Phase 2 · Step 2.4. Builds on the stock ledger from Step 1.3 (`stock_movements`, `stock_levels`) and on sales/refunds, which already write to it.

## Decisions (defaults, 2026-10-09; change on request)

- **One location in v1.** "Per location" uses the shop's single location (`getLocation`); no picker until multi-location.
- **Threshold is per product** (`products.low_stock_threshold`, null = no alert) and is compared with the product's **total on hand over its tracked, non-archived variants**.
- **Alerts** = a status on the Inventory list, a "Low stock" filter and a dashboard link. No email digest yet.
- **Valuation** = sum of `cost × on_hand` for variants with stock above zero and a cost. A variant with no cost is "not valued" (unknown, not zero); negative stock is counted aside and never netted off.

## Rules

- **Everything goes through `stock_movements`.** The existing trigger updates `stock_levels` in the same statement. Nothing edits `stock_levels`.
- **Reasons.** Manual: `received` (+), `damage` (-), `count`, `adjustment` (signed, not 0). Till: `sale`, `refund`. Setup: `opening`. Only managers and owners can insert manual reasons, as themselves; clients still cannot insert `sale` or `refund`.
- **Count** is "what is on the shelf". `public.adjust_stock` (SECURITY INVOKER, RLS applies) records `counted - on_hand` as one movement, serialising counts of the same variant with an advisory lock. A sale landing between the read and the insert leaves the count off by that sale (the trigger adds to the live total). A count equal to the system is refused.
- **Negative stock is allowed** (offline trading, deliveries entered late). It is shown with an icon and text, filtered under "Below zero", and excluded from the value.
- **Untracked products** (`track_stock = false`) and archived items never appear.
- **Thresholds** are written only from the Inventory page (`products.low_stock_threshold` update grant); `save_product` does not touch them, so editing a product cannot clear an alert level.
- **Notes** (max 200 chars) are stored on the movement. History shows the latest 100 movements per variant.

## Known limits

- The list and valuation load the whole tracked catalogue and filter in memory (`ponytail:` note in `src/lib/inventory.ts`): fine for a shop, move to a SQL view past ~20k variants.
- History does not name who made a movement or link to the sale/refund (`ref_id`).
- No stocktake sessions, transfers, suppliers or batch/expiry (v2).
- The dashboard reads the whole stock list to count low items (same limit).
