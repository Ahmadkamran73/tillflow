import { describe, expect, it } from "vitest";
import { apportion, assertInt, cashRound, roundHalfUp, splitVat } from "@/lib/money";

describe("assertInt", () => {
  it("returns a safe integer", () => expect(assertInt(-42)).toBe(-42));
  it.each([1.5, NaN, Infinity, -Infinity, 2 ** 53])("rejects %s", (n) =>
    expect(() => assertInt(n)).toThrow(RangeError),
  );
});

describe("roundHalfUp", () => {
  it.each([
    [0, 7, 0],
    [4, 10, 0],
    [5, 10, 1],
    [6, 10, 1],
    [14, 10, 1],
    [15, 10, 2],
    [-4, 10, 0],
    [-5, 10, -1],
    [-6, 10, -1],
    [-15, 10, -2],
    [2 ** 53 - 1, 2, 2 ** 52], // exact near the safe-integer limit
  ])("%i / %i = %i", (num, den, expected) => expect(roundHalfUp(num, den)).toBe(expected));

  it.each([0, -1, 1.5])("rejects denominator %s", (den) =>
    expect(() => roundHalfUp(1, den)).toThrow(RangeError),
  );
  it("rejects a fractional numerator", () => expect(() => roundHalfUp(0.5, 1)).toThrow(RangeError));
});

describe("splitVat", () => {
  // [rateBp, gross, net, vat]
  it.each([
    [2300, 0, 0, 0],
    [2300, 1, 1, 0],
    [2300, 99, 80, 19],
    [2300, 123, 100, 23],
    [2300, 1000, 813, 187],
    [2300, 2399, 1950, 449],
    [1350, 0, 0, 0],
    [1350, 1, 1, 0],
    [1350, 99, 87, 12],
    [1350, 1000, 881, 119],
    [1350, 2399, 2114, 285],
    [900, 0, 0, 0],
    [900, 1, 1, 0],
    [900, 99, 91, 8],
    [900, 1000, 917, 83],
    [900, 2399, 2201, 198],
    [480, 0, 0, 0],
    [480, 1, 1, 0],
    [480, 99, 94, 5],
    [480, 1000, 954, 46],
    [480, 2399, 2289, 110],
    [0, 0, 0, 0],
    [0, 1, 1, 0],
    [0, 99, 99, 0],
    [0, 1000, 1000, 0],
    [0, 2399, 2399, 0],
    // nearest-to-half cases at 23%: 0.5c above and below the boundary
    [2300, 6, 5, 1], // 4.878 → 5
    [2300, 31, 25, 6], // 25.20 → 25
  ])("%i bp of %i → net %i, VAT %i", (rateBp, gross, net, vat) => {
    expect(splitVat(gross, rateBp)).toEqual({ net, vat });
    // a refund is the exact mirror image
    expect(splitVat(-gross, rateBp)).toEqual({ net: -net || 0, vat: -vat || 0 });
  });

  it.each([-1, 10001, 1.5])("rejects rate %s", (rateBp) =>
    expect(() => splitVat(100, rateBp)).toThrow(RangeError),
  );
  it.each([1.5, 2 ** 50])("rejects gross %s", (gross) =>
    expect(() => splitVat(gross, 2300)).toThrow(RangeError),
  );
});

describe("apportion", () => {
  it.each([
    // meal deal: exact 428.57 / 333.33 / 238.10 → leftover cent to the biggest fraction
    [1000, [450, 350, 250], [429, 333, 238]],
    [-1000, [450, 350, 250], [-429, -333, -238]],
    [100, [600, 400], [60, 40]],
    [1, [0, 5], [0, 1]],
    [2, [1, 1, 1], [1, 1, 0]], // equal fractions and weights → earlier first
    [2, [1, 3], [0, 2]], // equal fractions 0.5 / 1.5 → larger weight
    [3, [1, 1, 1, 1, 1], [1, 1, 1, 0, 0]], // never more than its exact share rounded up
    [0, [1, 2], [0, 0]],
    [0, [0, 0], [0, 0]],
    [0, [], []],
  ])("%i over %j → %j", (total, weights, expected) => {
    const parts = apportion(total, weights);
    expect(parts).toEqual(expected);
    expect(parts.reduce((s, p) => s + p, 0)).toBe(total);
  });

  it("rejects a non-zero total over zero weights", () =>
    expect(() => apportion(5, [0, 0])).toThrow(RangeError));
  it.each([[[-1, 2]], [[1.5]]])("rejects weights %j", (weights) =>
    expect(() => apportion(5, weights)).toThrow(RangeError),
  );
  it("rejects totals that overflow", () =>
    expect(() => apportion(2 ** 40, [2 ** 20])).toThrow(RangeError));
});

describe("cashRound", () => {
  it.each([
    [1000, 1000, 0],
    [1001, 1000, -1],
    [1002, 1000, -2],
    [1003, 1005, 2],
    [1004, 1005, 1],
    [1005, 1005, 0],
    [1006, 1005, -1],
    [1007, 1005, -2],
    [1008, 1010, 2],
    [1009, 1010, 1],
    [0, 0, 0],
  ])("%i → %i (%i)", (cents, rounded, adjustment) => {
    expect(cashRound(cents)).toEqual({ rounded, adjustment });
    expect(cashRound(-cents)).toEqual({ rounded: -rounded || 0, adjustment: -adjustment || 0 });
  });
  it("rejects fractions", () => expect(() => cashRound(1.5)).toThrow(RangeError));
});
