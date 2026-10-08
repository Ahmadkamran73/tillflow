import { describe, expect, it } from "vitest";
import {
  cashDueOf,
  cashRound,
  defaultNonCashAmount,
  settleTenders,
  type TenderLine,
} from "@/lib/money";

const cash = (amount: number): TenderLine => ({ method: "cash", amount });
const card = (amount: number, tip?: number): TenderLine => ({ method: "card", amount, tip });
const voucher = (amount: number): TenderLine => ({ method: "voucher", amount });

describe("settleTenders", () => {
  it("cash only matches the single-cash behaviour (5c rounding, change)", () => {
    const s = settleTenders(1633, [cash(2000)]);
    expect(s).toMatchObject({ rounding: 2, amountDue: 1635, change: 365, ok: true, balance: 0 });
    expect(settleTenders(1635, [cash(1635)])).toMatchObject({ rounding: 0, change: 0, ok: true });
  });

  it("rounds down as well as up", () => {
    expect(settleTenders(1631, [cash(1630)])).toMatchObject({ rounding: -1, amountDue: 1630 });
  });

  it("card only is exact, never rounded", () => {
    const s = settleTenders(1633, [card(1633)]);
    expect(s).toMatchObject({ rounding: 0, amountDue: 1633, change: 0, ok: true, nonCash: 1633 });
  });

  it("rounds only the cash share of a split", () => {
    const s = settleTenders(2003, [card(1000), cash(1005)]);
    expect(s).toMatchObject({ cashShare: 1003, rounding: 2, amountDue: 2005, change: 0, ok: true });
    expect(settleTenders(2003, [card(1000), cash(2000)]).change).toBe(995);
  });

  it("does not depend on the order tenders were taken", () => {
    const a = settleTenders(2003, [card(500), voucher(500), cash(1005)]);
    const b = settleTenders(2003, [cash(1005), voucher(500), card(500)]);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  it("reports what is still owed while a split is built", () => {
    expect(settleTenders(2000, []).balance).toBe(2000);
    expect(settleTenders(2000, [card(500)])).toMatchObject({
      balance: 1500,
      error: "short",
      ok: false,
    });
    expect(settleTenders(2000, [card(500), cash(1000)])).toMatchObject({
      balance: 500,
      error: "short",
    });
  });

  it("rounds every last digit of the cash share the same way as single-cash (down 1-2, up 3-4, mirrored)", () => {
    const expected: Record<number, number> = {
      0: 0,
      1: -1,
      2: -2,
      3: 2,
      4: 1,
      5: 0,
      6: -1,
      7: -2,
      8: 2,
      9: 1,
    };
    for (const [digit, adj] of Object.entries(expected)) {
      const total = 1000 + Number(digit);
      expect(settleTenders(total, [cash(2000)]).rounding).toBe(adj);
    }
  });

  it("a 1-2c remainder after card settles by itself, with no cash tender", () => {
    expect(settleTenders(2001, [card(2000)])).toMatchObject({
      ok: true,
      rounding: -1,
      amountDue: 2000,
      balance: 0,
    });
    expect(settleTenders(2002, [card(2000)])).toMatchObject({
      ok: true,
      rounding: -2,
      amountDue: 2000,
    });
    // 3c is real money: it needs cash (3c rounds up to 5c).
    expect(settleTenders(2003, [card(2000)])).toMatchObject({
      ok: false,
      error: "short",
      balance: 3,
    });
    // And a cash tender of that remainder still works (a 5c coin, 5c change).
    expect(settleTenders(2001, [card(2000), cash(5)])).toMatchObject({
      ok: true,
      rounding: -1,
      change: 5,
    });
  });

  it("combines errors in a fixed order: two cash first, then non-cash over", () => {
    expect(settleTenders(1000, [cash(500), cash(500), card(2000)]).error).toBe("two_cash");
    expect(settleTenders(1000, [card(1500), cash(100)]).error).toBe("non_cash_over");
  });

  it("refuses short cash and gives no change from short", () => {
    const s = settleTenders(1000, [cash(999)]);
    expect(s).toMatchObject({ ok: false, error: "short", change: 0, balance: 1 });
  });

  it("refuses card or voucher above the total (no change from them)", () => {
    expect(settleTenders(1000, [card(1001)])).toMatchObject({ error: "non_cash_over", balance: 0 });
    expect(settleTenders(1000, [card(600), voucher(500)]).error).toBe("non_cash_over");
  });

  it("refuses a cash tender that is not needed", () => {
    expect(settleTenders(1000, [card(1000), cash(500)]).error).toBe("bad_amount");
  });

  it("refuses two cash tenders", () => {
    expect(settleTenders(1000, [cash(500), cash(500)]).error).toBe("two_cash");
  });

  it("refuses zero and negative amounts and negative tips", () => {
    expect(settleTenders(1000, [card(0)]).error).toBe("bad_amount");
    expect(settleTenders(1000, [card(-5)]).error).toBe("bad_amount");
    expect(settleTenders(1000, [card(1000, -1)]).error).toBe("bad_amount");
  });

  it("allows tips on card only, up to the card amount, outside the total", () => {
    const s = settleTenders(1000, [card(1000, 150)]);
    expect(s).toMatchObject({ ok: true, tips: 150, amountDue: 1000, change: 0 });
    expect(settleTenders(1000, [card(1000, 1000)]).ok).toBe(true);
    expect(settleTenders(1000, [card(1000, 1001)]).error).toBe("tip_too_big");
    expect(settleTenders(1000, [{ method: "cash", amount: 1000, tip: 50 }]).error).toBe(
      "tip_not_card",
    );
    expect(settleTenders(1000, [{ method: "voucher", amount: 1000, tip: 50 }]).error).toBe(
      "tip_not_card",
    );
  });

  it("settles a zero total with no tenders", () => {
    expect(settleTenders(0, [])).toMatchObject({ ok: true, amountDue: 0, change: 0 });
  });

  it("rejects non-integers", () => {
    expect(() => settleTenders(10.5, [])).toThrow();
    expect(() => settleTenders(1000, [card(10.5)])).toThrow();
    expect(() => settleTenders(1000, [card(1000, 0.5)])).toThrow();
  });

  it("holds for random splits: reconciles, rounds at most 2c, change only from cash", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const total = 1 + rnd(50_000);
      const c = rnd(total + 1);
      const v = rnd(total - c + 1);
      const rest = total - c - v;
      const lines: TenderLine[] = [];
      if (c > 0) lines.push(card(c, rnd(c + 1)));
      if (v > 0) lines.push(voucher(v));
      if (rest > 0) {
        const due = rest + cashRound(rest).adjustment;
        lines.push(cash(Math.max(due, 1) + rnd(3) * 500)); // a 1-2c remainder rounds to 0 due
      }
      const s = settleTenders(total, lines);
      expect(s.ok).toBe(true);
      expect(Math.abs(s.amountDue - total)).toBeLessThanOrEqual(2);
      expect(s.nonCash + s.cashShare).toBe(total);
      expect(s.change).toBeGreaterThanOrEqual(0);
      expect(s.cashTendered - s.change + s.nonCash).toBe(s.amountDue);
      if (rest === 0) expect(s.change).toBe(0);
    }
  });
});

describe("a shop that does not round cash (roundCash: false)", () => {
  const exact = { roundCash: false };
  it("takes the cash share to the cent, with change from the exact amount", () => {
    const s = settleTenders(1633, [cash(2000)], exact);
    expect(s).toMatchObject({ rounding: 0, amountDue: 1633, change: 367, ok: true });
    expect(settleTenders(1633, [cash(1632)], exact)).toMatchObject({
      ok: false,
      error: "short",
      balance: 1,
    });
  });
  it("a split rounds nothing, and a 1-2c remainder after card still needs cash", () => {
    expect(settleTenders(2003, [card(1000), cash(1003)], exact)).toMatchObject({
      rounding: 0,
      amountDue: 2003,
      ok: true,
    });
    expect(settleTenders(2001, [card(2000)], exact)).toMatchObject({
      ok: false,
      error: "short",
      balance: 1,
    });
  });
  it("rounds by default, and cashDueOf follows the flag", () => {
    expect(settleTenders(1633, [cash(2000)]).rounding).toBe(2);
    expect(cashDueOf(1633)).toBe(1635);
    expect(cashDueOf(1633, true)).toBe(1635);
    expect(cashDueOf(1633, false)).toBe(1633);
    expect(cashDueOf(0)).toBe(0);
    expect(cashDueOf(-5, false)).toBe(0);
    expect(() => cashDueOf(1.5)).toThrow();
  });
});

describe("defaultNonCashAmount", () => {
  it("is the exact amount left after card and voucher, ignoring cash", () => {
    expect(defaultNonCashAmount(2000, [])).toBe(2000);
    expect(defaultNonCashAmount(2000, [card(500), voucher(300), cash(100)])).toBe(1200);
    expect(defaultNonCashAmount(2000, [card(2500 - 500)])).toBe(0);
  });
  it("never goes below zero and rejects non-integers", () => {
    expect(defaultNonCashAmount(100, [card(500)])).toBe(0);
    expect(() => defaultNonCashAmount(100.5, [])).toThrow();
    expect(() => defaultNonCashAmount(100, [card(1.5)])).toThrow();
  });
});
