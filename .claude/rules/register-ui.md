---
paths:
  - "src/app/(register)/**"
---

# Register UI rules

The register is used by untrained cashiers, on tablets, in bright shops, often offline.

- **Touch targets ≥ 48×48 px** for every interactive control, with at least 8px between neighbours. Landscape tablet first (≥ 1024×768).
- **Solid, high-contrast surfaces.** No glass, blur or translucency on the register (that look is for back office and marketing). Text contrast ≥ 4.5:1 (3:1 for large text and UI boundaries).
- **WCAG 2.2 AA**: visible focus indicator that is not obscured, target size, no drag-only interactions (offer a tap alternative), labels on every input, semantic buttons/links, correct roles, logical focus order, `aria-live` for cart changes and errors.
- **Colour is never the only signal.** Online/offline, printer state, errors and stock warnings also use an icon and text.
- **Layout**: two panes (tiles/search left, cart + large Pay button right). The total is always visible. Tabular numerals for all amounts. Common sale in about 3 taps; scanning works anywhere on the screen.
- **Offline-first**: a sale writes to the local outbox first (UUIDv7 + idempotency key) and the receipt prints immediately. The UI must never block on the network. Show the status pill: Online · Offline (n waiting) · Syncing. Genuinely rejected sales are flagged to a manager, never silently dropped.
- **Display values from `src/lib/money`**; never compute VAT or totals in a component. Client totals are for display only; the server recalculates.
- **No personal data in logs** or client error reports. Customer names and emails stay out of console output.
- **Strings** go through the translation files, not inline literals.
- Run the `accessibility-reviewer` agent on new register screens before merge.
