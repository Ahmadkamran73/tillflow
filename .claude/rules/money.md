---
paths:
  - "src/lib/money/**"
---

# Money and VAT library rules

This is the only place VAT and rounding maths may live. Everything else calls it.

- **Integer cents only.** No floats, no `Number` fractions, no `toFixed` for calculation. Inputs and outputs are integers; reject non-integers at the boundary.
- **Rates in basis points** (`rate_bp`: 2300 = 23%, 1350 = 13.5%, 900 = 9%, 0 = 0%).
- **Prices are VAT-inclusive.** VAT for a line = `gross - round_half_up(gross * 10000 / (10000 + rate_bp))`, computed per line, never on the basket total.
- **Rounding is half-up to the cent**, one shared helper, applied per line. Document the rule where the helper is defined.
- **Snapshot the rate on the line**: `tax_rate_bp` and `tax_amount` are copied onto the sale line at sale time. Never look the rate up again for a completed sale.
- **Effective-dated rates**: choose the rate by sale date from `tax_rates` (`valid_from`/`valid_to`), e.g. hospitality 13.5% → 9% on 1 July 2026.
- **Eat-in vs take-away** and **meal-deal apportionment** are library functions with tests, per docs/PLAN.md section 12. Apportion by relative list price using largest remainder: floor each part, then give the leftover cents one each to the parts with the largest dropped fraction (ties: larger weight, then earlier line), so parts sum exactly and no part exceeds its exact share rounded up.
- **5c cash rounding** applies to the cash tender total only, is shown as its own receipt line, and never changes line VAT.
- **Sums must reconcile**: sum of line gross = total; sum of line VAT = VAT total. Property-test this.
- **100% test coverage** (statements, branches, functions, lines) for `src/lib/money/**`. Include table-driven cases for each rate, negative amounts (refunds), zero, and half-cent boundaries, plus property tests.
- Changes here need my line-by-line review. Say so in the PR summary.
