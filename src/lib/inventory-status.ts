/** Stock status of a product from its total on hand (all tracked variants) and its alert threshold. */
export type StockStatus = "negative" | "out" | "low" | "ok";

export function stockStatus(total: number, threshold: number | null): StockStatus {
  if (total < 0) return "negative";
  if (total === 0) return "out";
  if (threshold !== null && total <= threshold) return "low";
  return "ok";
}

/**
 * Value of stock at cost, in integer cents. Only positive stock with a known cost is valued: a
 * variant with no cost (unknown, not zero) or negative stock is counted aside, never netted off.
 */
export function valuation(rows: { onHand: number; costCents: number | null }[]): {
  totalCents: number;
  unvalued: number;
  negative: number;
} {
  let totalCents = 0;
  let unvalued = 0;
  let negative = 0;
  for (const r of rows) {
    if (r.onHand < 0) negative += 1;
    else if (r.onHand > 0 && r.costCents === null) unvalued += 1;
    else if (r.onHand > 0 && r.costCents !== null) totalCents += r.onHand * r.costCents;
  }
  return { totalCents, unvalued, negative };
}
