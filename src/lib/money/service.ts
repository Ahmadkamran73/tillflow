import { apportion, assertInt, roundHalfUp, splitVat } from "./vat";

/**
 * Service charge (restaurants): a per-shop percentage of the food and drink on a bill, part of the
 * same supply, so each cent is taxed at the rate of the item it was charged on.
 * `bp` is basis points (1250 = 12.5%). Amounts are integer cents; items are VAT-inclusive grosses.
 */
export interface ChargeItem {
  gross: number;
  rateBp: number;
}

export const MAX_SERVICE_CHARGE_BP = 2500;

/**
 * The charge on each item. The total is the percentage of all the gross, rounded half-up once, and
 * is apportioned over the items by gross (largest remainder), so the shares add up exactly to it
 * and a bill split into parts (each part takes the shares of its items) charges the same total.
 */
export function serviceChargeShares(items: readonly ChargeItem[], bp: number): number[] {
  assertInt(bp, "bp");
  if (bp < 0 || bp > MAX_SERVICE_CHARGE_BP)
    throw new RangeError(`bp must be 0..${MAX_SERVICE_CHARGE_BP}`);
  let gross = 0;
  for (const i of items) {
    assertInt(i.gross, "gross");
    if (i.gross < 0) throw new RangeError("gross must be >= 0");
    gross += i.gross;
  }
  return apportion(
    roundHalfUp(assertInt(gross * bp, "gross"), 10000),
    items.map((i) => i.gross),
  );
}

/** Charge shares grouped by VAT rate, each rate's charge split into net and VAT (one sale line per rate). */
export function serviceChargeByRate(
  items: readonly ChargeItem[],
  shares: readonly number[],
): { rateBp: number; gross: number; net: number; vat: number }[] {
  if (items.length !== shares.length) throw new RangeError("one share per item");
  const byRate = new Map<number, number>();
  items.forEach((it, i) =>
    byRate.set(it.rateBp, (byRate.get(it.rateBp) ?? 0) + assertInt(shares[i]!, "share")),
  );
  return [...byRate]
    .sort((a, b) => b[0] - a[0])
    .filter(([, gross]) => gross !== 0)
    .map(([rateBp, gross]) => ({ rateBp, gross, ...splitVat(gross, rateBp) }));
}

/**
 * Is `cents` an acceptable service charge for a bill whose eat-in food and drink come to `base`
 * cents at `bp` basis points? A split bill hands each part a whole-cent share of the whole bill's
 * charge, which can sit up to 1.5c from that part's own exact percentage (half a cent from rounding
 * the whole charge once, up to one cent from sharing it out). Anything further is refused, and a
 * charge is never accepted where the percentage is 0. Exact integer maths, no division.
 */
export function serviceChargeWithin(base: number, bp: number, cents: number): boolean {
  assertInt(base, "base");
  assertInt(bp, "bp");
  assertInt(cents, "cents");
  if (base < 0 || cents < 0 || bp < 0 || bp > MAX_SERVICE_CHARGE_BP) return false;
  if (bp === 0 || base === 0) return cents === 0;
  return (
    2 * Math.abs(assertInt(cents * 10000, "cents") - assertInt(base * bp, "base")) <= 3 * 10000
  );
}

/** An even split of `total` cents between `n` payers: parts differ by at most 1c and add up exactly. */
export function evenShares(total: number, n: number): number[] {
  if (!Number.isSafeInteger(n) || n < 1 || n > 10) throw new RangeError("n must be 1..10");
  return apportion(total, Array<number>(n).fill(1));
}
