import { describe, expect, it } from "vitest";
import { DEFAULT_DISCOUNT_LIMIT_BP, discountLimitOf } from "@/lib/register/feed";
import { discountNeedsOverride } from "@/lib/money";

describe("discountLimitOf (the till's saved copy of the shop)", () => {
  it("uses the shop's limit when the saved copy has one", () => {
    expect(discountLimitOf({ discountOverrideBp: 500 })).toBe(500);
    expect(discountLimitOf({ discountOverrideBp: 0 })).toBe(0);
    expect(discountLimitOf({ discountOverrideBp: 10_000 })).toBe(10_000);
  });

  it("falls back to the default for a copy saved before the limit existed, so the register still opens", () => {
    expect(discountLimitOf(undefined)).toBe(DEFAULT_DISCOUNT_LIMIT_BP);
    expect(discountLimitOf({})).toBe(DEFAULT_DISCOUNT_LIMIT_BP);
    // The shape staging had: an org saved by an older release, with no discountOverrideBp at all.
    const old = { name: "Shop", timezone: "Europe/Dublin" } as { discountOverrideBp?: number };
    expect(() => discountNeedsOverride([], discountLimitOf(old))).not.toThrow();
  });

  it("never hands a nonsense value to the money library", () => {
    for (const bad of [-1, 10_001, 12.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(discountLimitOf({ discountOverrideBp: bad })).toBe(DEFAULT_DISCOUNT_LIMIT_BP);
    }
    expect(DEFAULT_DISCOUNT_LIMIT_BP).toBe(1000);
  });
});
