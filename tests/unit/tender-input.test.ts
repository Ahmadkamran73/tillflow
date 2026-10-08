import { describe, expect, it } from "vitest";
import {
  looksLikeCardNumber,
  stripReferences,
  tenderInput,
  tenderReference,
  tendersInput,
} from "@/lib/register/tender-input";

const id = "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const base = { id, typeId: null, method: "card" as const, amountCents: 1000 };

describe("card-number rejection", () => {
  it.each([
    "4111111111111",
    "4111111111111111",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "4111/1111/1111/1111",
    "6011000990139424242",
    "REF 4111111111111111",
    "4111a1111a1111a1111", // letters between digits do not hide a card number
    "41 11 11 11 11 11 1",
  ])("refuses %s", (s) => {
    expect(looksLikeCardNumber(s)).toBe(true);
    expect(tenderReference.safeParse(s).success).toBe(false);
  });

  it.each(["123456789012", "A1B2C3D4E5F6G7", "AUTH 123456", "T-0042", "", "12 3456 7890 12"])(
    "accepts %s",
    (s) => {
      expect(tenderReference.safeParse(s).success).toBe(true);
    },
  );

  it("refuses odd characters and long text", () => {
    expect(tenderReference.safeParse("a;b").success).toBe(false);
    expect(tenderReference.safeParse("x".repeat(41)).success).toBe(false);
    expect(tenderReference.safeParse("x".repeat(40)).success).toBe(true);
  });
});

describe("tender input", () => {
  it("accepts a card tender with a reference and tip", () => {
    expect(
      tenderInput.safeParse({ ...base, reference: "AUTH 123456", tipCents: 100 }).success,
    ).toBe(true);
  });
  it("refuses a tip on cash or voucher, and unknown keys", () => {
    expect(tenderInput.safeParse({ ...base, method: "cash", tipCents: 5 }).success).toBe(false);
    expect(tenderInput.safeParse({ ...base, method: "voucher", tipCents: 5 }).success).toBe(false);
    expect(tenderInput.safeParse({ ...base, pan: "4111" }).success).toBe(false);
  });
  it("needs 1 to 10 tenders and at most one cash", () => {
    expect(tendersInput.safeParse([]).success).toBe(false);
    expect(tendersInput.safeParse(Array(11).fill(base)).success).toBe(false);
    const cash = { ...base, method: "cash" as const };
    expect(tendersInput.safeParse([cash, cash]).success).toBe(false);
    expect(tendersInput.safeParse([cash, base]).success).toBe(true);
  });
});

describe("exchange credit as a tender", () => {
  const credit = { ...base, method: "exchange" as const, refundId: id };
  it("names the refund that gave the credit, has no payment type, and at most one", () => {
    expect(tenderInput.safeParse(credit).success).toBe(true);
    expect(tenderInput.safeParse({ ...credit, refundId: undefined }).success).toBe(false);
    expect(tenderInput.safeParse({ ...base, refundId: id }).success).toBe(false); // card with a refund id
    expect(tenderInput.safeParse({ ...credit, typeId: id }).success).toBe(false);
    expect(tenderInput.safeParse({ ...credit, tipCents: 5 }).success).toBe(false);
    expect(tendersInput.safeParse([credit, credit]).success).toBe(false);
    expect(tendersInput.safeParse([credit, { ...base, method: "cash" as const }]).success).toBe(true);
  });
});

describe("stripReferences", () => {
  it("removes every reference, deeply, and leaves the rest", () => {
    const out = stripReferences({
      id: "a",
      tenders: [{ method: "card", reference: "4111111111111111", amountCents: 5 }],
      raw: { nested: [{ reference: "x", keep: 1 }] },
    });
    expect(JSON.stringify(out)).not.toContain("reference");
    expect(out.tenders[0]).toEqual({ method: "card", amountCents: 5 });
    expect(out.raw.nested[0]).toEqual({ keep: 1 });
  });
  it("passes primitives through", () => {
    expect(stripReferences(5)).toBe(5);
    expect(stripReferences(null)).toBe(null);
  });
});
