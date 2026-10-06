import { describe, expect, it } from "vitest";
import {
  DISCOUNT_ROUNDING_SLACK_CENTS,
  applyDiscount,
  calculateBasket,
  discountExceedsThreshold,
  discountNeedsOverride,
  lineDiscountOf,
} from "@/lib/money";
import { IRISH_RATES } from "./irish-rates";

const T = 1000; // 10%

describe("discountExceedsThreshold (exact integer maths)", () => {
  it("is false at exactly the threshold and true one cent over (past the rounding slack)", () => {
    // 10% of €100.00 = 1000c
    expect(discountExceedsThreshold(10_000, 1000, T)).toBe(false);
    expect(discountExceedsThreshold(10_000, 1000 + DISCOUNT_ROUNDING_SLACK_CENTS, T)).toBe(false);
    expect(discountExceedsThreshold(10_000, 1000 + DISCOUNT_ROUNDING_SLACK_CENTS + 1, T)).toBe(
      true,
    );
  });

  it("allows for the cent rounding of a percentage discount", () => {
    // 10% of €10.05 = 100.5c rounds half-up to 101c: still a "10% discount".
    const lost = 10_05 - applyDiscount(10_05, { percentBp: T });
    expect(lost).toBe(101);
    expect(discountExceedsThreshold(10_05, lost, T)).toBe(false);
  });

  it("never flags a discount of no more than the slack, however small the price", () => {
    expect(discountExceedsThreshold(5, 2, T)).toBe(false);
    expect(discountExceedsThreshold(5, 3, T)).toBe(true);
    expect(discountExceedsThreshold(100, 0, 0)).toBe(false);
    expect(discountExceedsThreshold(100, DISCOUNT_ROUNDING_SLACK_CENTS, 0)).toBe(false);
  });

  it("a threshold of 0 flags any real discount; 100% flags nothing", () => {
    expect(discountExceedsThreshold(1000, 3, 0)).toBe(true);
    expect(discountExceedsThreshold(1000, 1000, 10_000)).toBe(false);
  });

  it("has nothing to discount on a zero or negative price", () => {
    expect(discountExceedsThreshold(0, 500, T)).toBe(false);
    expect(discountExceedsThreshold(-500, 500, T)).toBe(false);
  });

  it("stays exact for the biggest amounts a sale may hold", () => {
    expect(discountExceedsThreshold(99_900_000_000, 9_990_000_000, T)).toBe(false);
    expect(discountExceedsThreshold(99_900_000_000, 9_990_000_003, T)).toBe(true);
  });

  it("rejects non-integers and an out-of-range threshold", () => {
    expect(() => discountExceedsThreshold(10.5, 1, T)).toThrow();
    expect(() => discountExceedsThreshold(100, 1.5, T)).toThrow();
    expect(() => discountExceedsThreshold(100, 1, 10.5)).toThrow();
    expect(() => discountExceedsThreshold(100, 1, -1)).toThrow(RangeError);
    expect(() => discountExceedsThreshold(100, 1, 10_001)).toThrow(RangeError);
  });
});

/** Prices a cart through the real basket and returns what discountNeedsOverride sees. */
function needs(
  items: { unit: number; qty: number; discount?: { amount: number } | { percentBp: number } }[],
  basketDiscount: { amount: number } | { percentBp: number } | undefined,
  thresholdBp = T,
) {
  const basket = calculateBasket({
    country: "IE",
    date: "2026-10-06",
    rates: IRISH_RATES,
    mode: "eat_in",
    tender: "card",
    basketDiscount,
    lines: items.map((i) => ({
      kind: "item" as const,
      unitPrice: i.unit,
      qty: i.qty,
      taxCategory: "STANDARD" as const,
      discount: i.discount,
    })),
  });
  const gross = (idx: number) =>
    basket.vatLines.filter((v) => v.index === idx).reduce((s, v) => s + v.gross, 0);
  return discountNeedsOverride(
    items.map((i, idx) => ({ unitPrice: i.unit, qty: i.qty, gross: gross(idx) })),
    thresholdBp,
  );
}

describe("discountNeedsOverride through the real basket", () => {
  it("no discount, and a discount at the threshold, need no override", () => {
    expect(needs([{ unit: 350, qty: 2 }], undefined)).toBe(false);
    expect(needs([{ unit: 350, qty: 2, discount: { percentBp: T } }], undefined)).toBe(false);
    expect(needs([{ unit: 1000, qty: 1 }], { percentBp: T })).toBe(false);
  });

  it("a line discount above the threshold needs an override", () => {
    expect(needs([{ unit: 1000, qty: 1, discount: { percentBp: 1500 } }], undefined)).toBe(true);
    expect(needs([{ unit: 1000, qty: 1, discount: { amount: 300 } }], undefined)).toBe(true);
  });

  it("a basket discount above the threshold needs an override", () => {
    expect(
      needs(
        [
          { unit: 500, qty: 1 },
          { unit: 700, qty: 2 },
        ],
        { percentBp: 2000 },
      ),
    ).toBe(true);
  });

  it("a 10% basket discount over awkward prices is not flagged by cent rounding", () => {
    expect(
      needs(
        [
          { unit: 105, qty: 1 },
          { unit: 195, qty: 1 },
          { unit: 5, qty: 3 },
          { unit: 1, qty: 1 },
        ],
        { percentBp: T },
      ),
    ).toBe(false);
  });

  it("line and basket discounts add up: two 6% discounts are more than 10% in total", () => {
    expect(
      needs([{ unit: 10_000, qty: 1, discount: { percentBp: 600 } }], { percentBp: 600 }),
    ).toBe(true);
  });

  it("one heavily discounted cheap line is flagged even when the sale as a whole is not", () => {
    // €1.00 item at 50% off beside a €100.00 item: the sale lost under 1%, the line lost half.
    expect(
      needs(
        [
          { unit: 100, qty: 1, discount: { percentBp: 5000 } },
          { unit: 10_000, qty: 1 },
        ],
        undefined,
      ),
    ).toBe(true);
  });

  it("a shop can set the threshold to 0 (everything) or 100% (nothing)", () => {
    const cart = [{ unit: 1000, qty: 1, discount: { percentBp: 500 } }];
    expect(needs(cart, undefined, 0)).toBe(true);
    expect(
      needs([{ unit: 1000, qty: 1, discount: { percentBp: 10_000 } }], undefined, 10_000),
    ).toBe(false);
  });

  it("an empty sale needs nothing", () => {
    expect(discountNeedsOverride([], T)).toBe(false);
  });

  it("agrees with lineDiscountOf, the figure printed on the receipt", () => {
    expect(lineDiscountOf(1000, 1, 850)).toBe(150);
    expect(discountNeedsOverride([{ unitPrice: 1000, qty: 1, gross: 850 }], T)).toBe(true);
    expect(discountNeedsOverride([{ unitPrice: 1000, qty: 1, gross: 900 }], T)).toBe(false);
  });
});
