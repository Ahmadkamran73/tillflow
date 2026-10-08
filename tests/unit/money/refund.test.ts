import { describe, expect, it } from "vitest";
import {
  refundDeposit,
  refundLine,
  refundNeedsOverride,
  refundTotals,
  settleRefund,
  splitVat,
  suggestRefundLegs,
  type RefundAvailable,
  type RefundLeg,
} from "@/lib/money";

const avail = (cash = 0, card = 0, voucher = 0): RefundAvailable => ({ cash, card, voucher });
const leg = (method: RefundLeg["method"], amount: number, tip?: number): RefundLeg => ({
  method,
  amount,
  tip,
});

/** A tiny seeded generator so the property test is the same on every run. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("refundLine", () => {
  it.each([
    // [rateBp, gross, qty, refundQty, expected gross, expected vat]
    [2300, 1230, 1, 1, 1230, 230],
    [2300, 2460, 2, 1, 1230, 230],
    [1350, 1135, 1, 1, 1135, 135],
    [900, 1090, 1, 1, 1090, 90],
    [0, 500, 1, 1, 500, 0],
  ])("rate %i: refunds %i/%i units at the original rate", (rateBp, gross, qty, n, eg, ev) => {
    const { vat } = splitVat(gross, rateBp);
    const r = refundLine({ qty, gross, vat, refundedQty: 0, refundQty: n });
    expect(r).toEqual({ gross: eg, vat: ev, net: eg - ev });
  });

  it("splits an uneven line with the rounding remainder on the last unit", () => {
    // 3 units, gross 1000 (333.33 each), vat 187 (62.33 each)
    const first = refundLine({ qty: 3, gross: 1000, vat: 187, refundedQty: 0, refundQty: 1 });
    const second = refundLine({ qty: 3, gross: 1000, vat: 187, refundedQty: 1, refundQty: 1 });
    const third = refundLine({ qty: 3, gross: 1000, vat: 187, refundedQty: 2, refundQty: 1 });
    expect(first).toEqual({ gross: 333, vat: 62, net: 271 });
    expect(second).toEqual({ gross: 334, vat: 63, net: 271 });
    expect(third).toEqual({ gross: 333, vat: 62, net: 271 });
  });

  it("rounds a half cent up (away from zero)", () => {
    // gross 5 over 2 units: 2.5 -> 3, then 2
    expect(refundLine({ qty: 2, gross: 5, vat: 1, refundedQty: 0, refundQty: 1 })).toMatchObject({
      gross: 3,
      vat: 1,
    });
    expect(refundLine({ qty: 2, gross: 5, vat: 1, refundedQty: 1, refundQty: 1 })).toMatchObject({
      gross: 2,
      vat: 0,
    });
  });

  it("keeps a discounted line's stored VAT (does not re-split the refund)", () => {
    // sold 2 at 1000, 10% off: line gross 1800, stored vat 337 (23%); refund one unit
    const r = refundLine({ qty: 2, gross: 1800, vat: 337, refundedQty: 0, refundQty: 1 });
    expect(r.gross).toBe(900);
    expect(r.vat).toBe(169); // 168.5 rounded up
    const rest = refundLine({ qty: 2, gross: 1800, vat: 337, refundedQty: 1, refundQty: 1 });
    expect(r.vat + rest.vat).toBe(337);
  });

  it("keeps the ORIGINAL rate across the 1 July 2026 change", () => {
    // sold in June at 13.5%: 1135 gross, 135 VAT; refunded in August it is still 13.5%
    const { vat } = splitVat(1135, 1350);
    const r = refundLine({ qty: 1, gross: 1135, vat, refundedQty: 0, refundQty: 1 });
    expect(r.vat).toBe(135);
    // a 9% re-split would differ
    expect(splitVat(1135, 900).vat).not.toBe(135);
  });

  it("refunding every unit one at a time equals the original line (1,000 seeded lines)", () => {
    const next = rng(42);
    const rates = [2300, 1350, 900, 0];
    for (let i = 0; i < 1000; i++) {
      const qty = 1 + Math.floor(next() * 12);
      const gross = 1 + Math.floor(next() * 50_000);
      const rateBp = rates[Math.floor(next() * rates.length)]!;
      const { vat } = splitVat(gross, rateBp);
      let g = 0;
      let v = 0;
      let done = 0;
      while (done < qty) {
        const n = 1 + Math.floor(next() * (qty - done));
        const part = refundLine({ qty, gross, vat, refundedQty: done, refundQty: n });
        expect(part.gross).toBeGreaterThanOrEqual(0);
        expect(part.vat).toBeLessThanOrEqual(part.gross);
        g += part.gross;
        v += part.vat;
        done += n;
      }
      expect(g).toBe(gross);
      expect(v).toBe(vat);
    }
  });

  it("rejects bad input", () => {
    const ok = { qty: 2, gross: 100, vat: 10, refundedQty: 0, refundQty: 1 };
    expect(() => refundLine({ ...ok, qty: 0 })).toThrow(RangeError);
    expect(() => refundLine({ ...ok, gross: -1 })).toThrow(RangeError);
    expect(() => refundLine({ ...ok, vat: -1 })).toThrow(RangeError);
    expect(() => refundLine({ ...ok, vat: 101 })).toThrow(RangeError);
    expect(() => refundLine({ ...ok, refundQty: 0 })).toThrow(RangeError);
    expect(() => refundLine({ ...ok, refundedQty: 2 })).toThrow(RangeError);
    expect(() => refundLine({ ...ok, refundedQty: -1 })).toThrow(RangeError);
    expect(() => refundLine({ ...ok, refundQty: 3 })).toThrow(RangeError);
    expect(() => refundLine({ ...ok, gross: 1.5 })).toThrow(RangeError);
  });
});

describe("refundDeposit", () => {
  it("is the unit deposit times the units returned", () => {
    expect(refundDeposit(15, 3)).toBe(45);
    expect(() => refundDeposit(-1, 1)).toThrow(RangeError);
    expect(() => refundDeposit(15, 0)).toThrow(RangeError);
  });
});

describe("refundTotals", () => {
  it("groups by the original rate and adds the deposit outside VAT", () => {
    const t = refundTotals(
      [
        { rateBp: 2300, gross: 1230, vat: 230 },
        { rateBp: 900, gross: 1090, vat: 90 },
        { rateBp: 2300, gross: 123, vat: 23 },
      ],
      [15, 15],
    );
    expect(t).toMatchObject({ itemsTotal: 2443, vatTotal: 343, nonVatTotal: 30, total: 2473 });
    expect(t.vatByRate).toEqual([
      { rateBp: 900, gross: 1090, net: 1000, vat: 90 },
      { rateBp: 2300, gross: 1353, net: 1100, vat: 253 },
    ]);
  });

  it("is empty for no lines", () => {
    expect(refundTotals([])).toMatchObject({ total: 0, vatByRate: [] });
  });
});

describe("settleRefund", () => {
  it("refunds a cash sale in cash with 5c rounding on the cash leg", () => {
    const s = settleRefund(1633, [leg("cash", 1635)], avail(1635));
    expect(s).toMatchObject({ rounding: 2, cashDue: 1635, ok: true, balance: 0, payout: 1633 });
    expect(settleRefund(1631, [leg("cash", 1630)], avail(1630))).toMatchObject({
      rounding: -1,
      ok: true,
    });
  });

  it("does not round when the shop does not", () => {
    expect(
      settleRefund(1633, [leg("cash", 1633)], avail(1633), { roundCash: false }),
    ).toMatchObject({
      rounding: 0,
      ok: true,
    });
  });

  it("never rounds a card-only refund", () => {
    expect(settleRefund(1633, [leg("card", 1633)], avail(0, 1633))).toMatchObject({
      rounding: 0,
      ok: true,
    });
  });

  it("rounds only the cash share of a split refund", () => {
    const s = settleRefund(1633, [leg("card", 1000), leg("cash", 635)], avail(700, 1000));
    expect(s).toMatchObject({ rounding: 2, cashDue: 635, ok: true });
  });

  it("refuses a method above what it paid (card sale cannot be paid back in cash)", () => {
    expect(settleRefund(1000, [leg("cash", 1000)], avail(0, 1000)).error).toBe("over_method");
    expect(settleRefund(1000, [leg("card", 1000)], avail(0, 900)).error).toBe("over_method");
    expect(settleRefund(1000, [leg("voucher", 1000)], avail(1000)).error).toBe("over_method");
  });

  it("allows the cash leg 2c of rounding slack only when cash was paid", () => {
    expect(settleRefund(1003, [leg("cash", 1005)], avail(1003))).toMatchObject({ ok: true });
    expect(settleRefund(1003, [leg("cash", 1005)], avail(0, 1003)).error).toBe("over_method");
  });

  it("reports what is still to allocate while building a split", () => {
    expect(settleRefund(1000, [leg("card", 400)], avail(0, 1000))).toMatchObject({
      ok: false,
      error: "short",
      balance: 600,
    });
    expect(settleRefund(1000, [], avail(1000))).toMatchObject({ error: "short", balance: 1000 });
  });

  it("lets cash drift 2c per refund so the last refund of a rounded cash sale is never stuck", () => {
    // 3 x 10.04 paid in cash: 30.12 rounds to 30.10. Each 10.04 refund rounds up to 10.05.
    const paid = 3010;
    const second = settleRefund(1004, [leg("cash", 1005)], avail(paid - 1005), { cashSlack: 2 * 2 });
    expect(second.ok).toBe(true);
    // the third has 1000 left in the till's books but needs 1005: three refunds, 6c of slack
    const third = settleRefund(1004, [leg("cash", 1005)], avail(paid - 2010), { cashSlack: 2 * 3 });
    expect(third.ok).toBe(true);
    // with only the default 2c it is the dead end the slack exists to avoid
    expect(settleRefund(1004, [leg("cash", 1005)], avail(paid - 2010)).error).toBe("over_method");
    // and slack never turns on cash for a sale that took none
    expect(settleRefund(1004, [leg("cash", 1005)], avail(0, 1004), { cashSlack: 6 }).error).toBe(
      "over_method",
    );
  });

  it("settles a 1-2c remainder by itself", () => {
    expect(settleRefund(2001, [leg("card", 2000)], avail(0, 2000))).toMatchObject({
      ok: true,
      rounding: -1,
      cashDue: 0,
    });
    expect(settleRefund(2003, [leg("card", 2000)], avail(0, 2000))).toMatchObject({
      error: "short",
      balance: 3,
    });
  });

  it("rejects the wrong cash amount, two cash legs, bad legs and tips off card", () => {
    expect(settleRefund(1633, [leg("cash", 1633)], avail(1633)).error).toBe("short");
    expect(settleRefund(1000, [leg("cash", 500), leg("cash", 500)], avail(1000)).error).toBe(
      "two_cash",
    );
    expect(settleRefund(1000, [leg("card", 0)], avail(0, 1000)).error).toBe("bad_amount");
    expect(settleRefund(1000, [leg("card", 1000, -1)], avail(0, 1000)).error).toBe("bad_amount");
    expect(settleRefund(1000, [leg("cash", 1000, 50)], avail(1000)).error).toBe("tip_not_card");
    expect(settleRefund(1000, [leg("card", 1200)], avail(0, 1200))).toMatchObject({
      error: "over",
      balance: 0,
    });
    // a cash leg when card already covers everything
    expect(settleRefund(1000, [leg("card", 1000), leg("cash", 5)], avail(10, 1000)).error).toBe(
      "bad_amount",
    );
  });

  it("returns a card tip with a void, outside the total", () => {
    const s = settleRefund(1000, [leg("card", 1000, 150)], avail(0, 1000));
    expect(s).toMatchObject({ ok: true, tips: 150, payout: 1000 });
  });

  it("applies exchange credit to the new sale and pays out only the difference", () => {
    // 3000 of returns, 2000 of credit used: 1000 goes back, 5c rounding on the cash share
    expect(settleRefund(3000, [leg("cash", 1000)], avail(3000), { credit: 2000 })).toMatchObject({
      ok: true,
      payout: 1000,
    });
    // credit covers everything: nothing to pay out
    expect(settleRefund(3000, [], avail(3000), { credit: 3000 })).toMatchObject({
      ok: true,
      payout: 0,
      balance: 0,
    });
    expect(() => settleRefund(1000, [], avail(1000), { credit: 1001 })).toThrow(RangeError);
    expect(() => settleRefund(-1, [], avail(0))).toThrow(RangeError);
  });
});

describe("suggestRefundLegs", () => {
  it("fills card first, then voucher, cash last", () => {
    const legs = suggestRefundLegs(2000, avail(1000, 800, 300));
    expect(legs).toEqual([
      { method: "card", amount: 800 },
      { method: "voucher", amount: 300 },
      { method: "cash", amount: 900 },
    ]);
    expect(settleRefund(2000, legs, avail(1000, 800, 300)).ok).toBe(true);
  });

  it("rounds the cash leg and skips empty ones", () => {
    const legs = suggestRefundLegs(1633, avail(1633));
    expect(legs).toEqual([{ method: "cash", amount: 1635 }]);
    expect(suggestRefundLegs(1633, avail(1633), { roundCash: false })).toEqual([
      { method: "cash", amount: 1633 },
    ]);
    expect(suggestRefundLegs(2001, avail(1, 2000))).toEqual([{ method: "card", amount: 2000 }]);
    expect(suggestRefundLegs(2000, avail(0, 5000))).toEqual([{ method: "card", amount: 2000 }]);
    expect(suggestRefundLegs(3000, avail(3000), { credit: 3000 })).toEqual([]);
  });
});

describe("refundNeedsOverride", () => {
  it("applies to cashiers above the limit only", () => {
    expect(refundNeedsOverride(2001, 2000, "cashier")).toBe(true);
    expect(refundNeedsOverride(2000, 2000, "cashier")).toBe(false);
    expect(refundNeedsOverride(99_999, 2000, "manager")).toBe(false);
    expect(refundNeedsOverride(99_999, 2000, "owner")).toBe(false);
  });
});
