/** Throws unless `n` is a safe integer (cents, quantity or basis points); returns it with -0 as 0. */
export function assertInt(n: number, what = "amount"): number {
  if (!Number.isSafeInteger(n)) throw new RangeError(`${what} must be a safe integer, got ${n}`);
  return n + 0;
}

/**
 * The one rounding rule: `num / den` rounded half-up to an integer, where "half-up" means half
 * away from zero, so a refund (negative) rounds to the exact negative of the sale.
 */
export function roundHalfUp(num: number, den: number): number {
  assertInt(num, "numerator");
  if (!Number.isSafeInteger(den) || den <= 0) throw new RangeError(`denominator must be > 0`);
  const a = Math.abs(num);
  const r = a % den; // exact integer division: no float rounding near 2^53
  const q = (a - r) / den + (2 * r >= den ? 1 : 0);
  return num < 0 ? 0 - q : q;
}

/** Splits a VAT-inclusive gross (cents) at `rateBp` (2300 = 23%) into net and VAT. */
export function splitVat(gross: number, rateBp: number): { net: number; vat: number } {
  gross = assertInt(gross, "gross");
  if (!Number.isSafeInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
    throw new RangeError(`rateBp must be 0..10000, got ${rateBp}`);
  }
  const net = roundHalfUp(assertInt(gross * 10000, "gross"), 10000 + rateBp);
  return { net, vat: gross - net };
}

/**
 * Splits `total` cents in proportion to non-negative integer `weights` (largest remainder): each
 * part is floored, then the leftover cents go one each to the parts with the largest dropped
 * fraction (ties: larger weight, then earlier). Parts sum exactly to `total` and each is within
 * 1c of its exact share, so a discount share never exceeds its line.
 */
export function apportion(total: number, weights: readonly number[]): number[] {
  assertInt(total, "total");
  let sum = 0;
  for (const w of weights) {
    if (assertInt(w, "weight") < 0) throw new RangeError("weights must be >= 0");
    sum += w;
  }
  if (sum === 0) {
    if (total !== 0) throw new RangeError("cannot apportion a non-zero total over zero weights");
    return weights.map(() => 0);
  }
  const a = Math.abs(total);
  const shares = weights.map((w, i) => {
    const x = assertInt(a * w, "total");
    const rem = x % sum; // exact integer division
    return { i, w, rem, part: (x - rem) / sum };
  });
  const leftover = a - shares.reduce((s, p) => s + p.part, 0);
  [...shares]
    .sort((x, y) => y.rem - x.rem || y.w - x.w || x.i - y.i)
    .slice(0, leftover)
    .forEach((s) => s.part++);
  return shares.map((s) => (total < 0 ? 0 - s.part : s.part));
}

/** Rounds a cash total to the nearest 5c (1–2c down, 3–4c up, mirrored for negatives). */
export function cashRound(cents: number): { rounded: number; adjustment: number } {
  const rounded = roundHalfUp(assertInt(cents, "cents"), 5) * 5;
  return { rounded, adjustment: rounded - cents };
}
