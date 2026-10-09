import { describe, expect, it } from "vitest";
import { adjustInput, thresholdInput } from "@/lib/inventory-schema";
import { stockStatus, valuation } from "@/lib/inventory-status";

const ids = {
  orgId: "0190f3a0-0000-7000-8000-000000000001",
  variantId: "0190f3a0-0000-7000-8000-000000000002",
  productId: "0190f3a0-0000-7000-8000-000000000003",
};
const adj = (reason: string, qty: string, note = "") =>
  adjustInput.safeParse({ ...ids, reason, qty, note }).success;

describe("stockStatus", () => {
  it("flags negative and out first, then low at or below the threshold", () => {
    expect(stockStatus(-1, 5)).toBe("negative");
    expect(stockStatus(0, null)).toBe("out");
    expect(stockStatus(5, 5)).toBe("low");
    expect(stockStatus(6, 5)).toBe("ok");
    expect(stockStatus(1, null)).toBe("ok");
  });
});

describe("valuation", () => {
  it("values positive stock with a cost; counts the rest aside", () => {
    expect(
      valuation([
        { onHand: 3, costCents: 250 },
        { onHand: 2, costCents: null },
        { onHand: -4, costCents: 100 },
        { onHand: 0, costCents: 900 },
      ]),
    ).toEqual({ totalCents: 750, unvalued: 1, negative: 1 });
  });
});

describe("adjustInput", () => {
  it("accepts sensible quantities per reason", () => {
    expect(adj("received", "10")).toBe(true);
    expect(adj("damage", "2", "dropped")).toBe(true);
    expect(adj("count", "0")).toBe(true);
    expect(adj("adjustment", "-3")).toBe(true);
  });
  it("rejects the wrong sign, zero, junk and long notes", () => {
    expect(adj("received", "0")).toBe(false);
    expect(adj("received", "-1")).toBe(false);
    expect(adj("damage", "-1")).toBe(false);
    expect(adj("count", "-1")).toBe(false);
    expect(adj("adjustment", "0")).toBe(false);
    expect(adj("sale", "1")).toBe(false); // sales come from the till only
    expect(adj("received", "1.5")).toBe(false);
    expect(adj("received", "abc")).toBe(false);
    expect(adj("received", "1", "x".repeat(201))).toBe(false);
  });
});

describe("thresholdInput", () => {
  it("empty clears the alert; numbers set it; junk is refused", () => {
    expect(thresholdInput.parse({ ...ids, threshold: "" }).threshold).toBeNull();
    expect(thresholdInput.parse({ ...ids, threshold: "5" }).threshold).toBe(5);
    expect(thresholdInput.safeParse({ ...ids, threshold: "-1" }).success).toBe(false);
    expect(thresholdInput.safeParse({ ...ids, threshold: "2000000" }).success).toBe(false);
  });
});
