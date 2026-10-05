import { describe, expect, it } from "vitest";
import { centsToInput, formatCents, parseCents } from "@/lib/money";

describe("parseCents", () => {
  it("parses plain amounts exactly", () => {
    expect(parseCents("3")).toBe(300);
    expect(parseCents("3.5")).toBe(350);
    expect(parseCents(" 3.50 ")).toBe(350);
    expect(parseCents("0.07")).toBe(7);
    expect(parseCents("1230.99")).toBe(123099);
    expect(parseCents("0")).toBe(0);
  });
  it("refuses anything else", () => {
    for (const bad of ["", "abc", "3.505", "3,50", "€3", "1e3", ".5", "3.", "12345678"]) {
      expect(parseCents(bad), bad).toBeNull();
    }
  });
  it("allows negatives only when asked", () => {
    expect(parseCents("-0.50")).toBeNull();
    expect(parseCents("-0.50", { allowNegative: true })).toBe(-50);
  });
});

describe("formatCents / centsToInput", () => {
  it("formats euro amounts", () => {
    expect(formatCents(350)).toBe("€3.50");
    expect(formatCents(123456)).toBe("€1,234.56");
    expect(formatCents(-50)).toContain("0.50");
  });
  it("round-trips through parseCents", () => {
    for (const c of [0, 5, 99, 100, 350, 123099, -250]) {
      expect(parseCents(centsToInput(c), { allowNegative: true })).toBe(c);
    }
  });
  it("rejects non-integers", () => {
    expect(() => formatCents(1.5)).toThrow(RangeError);
    expect(() => centsToInput(1.5)).toThrow(RangeError);
  });
});
