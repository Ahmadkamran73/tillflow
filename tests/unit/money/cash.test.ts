import { describe, expect, it } from "vitest";
import { changeDue, lineDiscountOf, quickCash } from "@/lib/money";

describe("changeDue", () => {
  it("returns the difference", () => {
    expect(changeDue(2000, 1635)).toBe(365);
    expect(changeDue(1635, 1635)).toBe(0);
  });
  it("throws when short or not integer", () => {
    expect(() => changeDue(1000, 1001)).toThrow(RangeError);
    expect(() => changeDue(10.5, 5)).toThrow();
    expect(() => changeDue(10, 5.5)).toThrow();
  });
});

describe("quickCash", () => {
  it("starts with exact, then rounds up per note size", () => {
    expect(quickCash(1635)).toEqual([1635, 2000, 5000]);
    expect(quickCash(320)).toEqual([320, 500, 1000, 2000]);
  });
  it("dedupes when the due is already a note multiple", () => {
    expect(quickCash(1000)).toEqual([1000, 2000, 5000]);
  });
  it("has nothing for a zero or negative due", () => {
    expect(quickCash(0)).toEqual([]);
    expect(quickCash(-5)).toEqual([]);
  });
  it("is capped at four", () => {
    expect(quickCash(1)).toHaveLength(4);
  });
  it("rejects non-integers", () => {
    expect(() => quickCash(1.5)).toThrow();
  });
});

describe("lineDiscountOf", () => {
  it("is the full price less what the line came to", () => {
    expect(lineDiscountOf(1000, 2, 1800)).toBe(200);
    expect(lineDiscountOf(1000, 2, 2000)).toBe(0);
    expect(lineDiscountOf(1000, -2, -1800)).toBe(-200); // a refund mirrors the sale
  });
  it("rejects non-integers", () => {
    expect(() => lineDiscountOf(10, 1, 9.5)).toThrow();
  });
});
