/**
 * "10", "7.5" or "12.25" (percent) to basis points, exactly: no floating point. null when it is not
 * a number from 0 to 100 with at most two decimals. Display and form parsing only; the rule itself
 * (src/lib/money discountNeedsOverride) works on the basis points.
 */
export function parseDiscountLimit(input: string): number | null {
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number((m[2] ?? "").padEnd(2, "0"));
  const bp = whole * 100 + frac;
  return bp <= 10_000 ? bp : null;
}

/** Basis points to the text for the form field: 1000 becomes "10", 750 becomes "7.5". */
export function discountLimitText(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = String(bp % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}
