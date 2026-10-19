import { describe, expect, it } from "vitest";
import { expectedCash, overShort, sumMovements } from "@/lib/money";

const base = { float: 10000, cashSales: 0, cashIn: 0, cashOut: 0, cashRefunds: 0 };

describe("expectedCash", () => {
  it.each([
    ["float only", base, 10000],
    ["cash sales", { ...base, cashSales: 4535 }, 14535],
    ["cash in and out", { ...base, cashIn: 2000, cashOut: 500 }, 11500],
    ["cash refunds leave the drawer", { ...base, cashSales: 3000, cashRefunds: 1250 }, 11750],
    ["cash out larger than sales", { ...base, cashSales: 500, cashOut: 9000 }, 1500],
    ["zero float, nothing", { ...base, float: 0 }, 0],
    ["can go below zero if the data says so", { ...base, float: 0, cashRefunds: 100 }, -100],
  ])("%s", (_n, facts, want) => expect(expectedCash(facts)).toBe(want));

  it("rejects fractions and negatives", () => {
    expect(() => expectedCash({ ...base, cashSales: 1.5 })).toThrow();
    expect(() => expectedCash({ ...base, cashOut: -1 })).toThrow(RangeError);
  });

  it("matches the formula for seeded random shifts", () => {
    let s = 12345;
    const rnd = (n: number) => ((s = (s * 1103515245 + 12345) % 2147483648), s % n);
    for (let i = 0; i < 1000; i++) {
      const f = {
        float: rnd(50000),
        cashSales: rnd(500000),
        cashIn: rnd(20000),
        cashOut: rnd(20000),
        cashRefunds: rnd(30000),
      };
      expect(expectedCash(f)).toBe(f.float + f.cashSales + f.cashIn - f.cashOut - f.cashRefunds);
    }
  });
});

describe("overShort", () => {
  it.each([
    [14535, 14535, 0],
    [14335, 14535, -200], // short by 2.00
    [14540, 14535, 5], // over by 0.05
    [0, 1500, -1500],
    [100, -100, 200],
  ])("counted %i vs expected %i = %i", (c, e, want) => expect(overShort(c, e)).toBe(want));

  it("rejects a negative or fractional count", () => {
    expect(() => overShort(-1, 0)).toThrow(RangeError);
    expect(() => overShort(1.5, 0)).toThrow();
    expect(() => overShort(0, 0.5)).toThrow();
  });

  it("over/short plus expected is always the count", () => {
    const pairs: [number, number][] = [
      [1234, 99],
      [0, 0],
      [5, 9000],
    ];
    for (const [c, e] of pairs) expect(overShort(c, e) + e).toBe(c);
  });
});

describe("sumMovements", () => {
  it("adds ins and outs separately", () => {
    expect(
      sumMovements([
        { kind: "in", amount: 500 },
        { kind: "out", amount: 200 },
        { kind: "in", amount: 25 },
      ]),
    ).toEqual({ cashIn: 525, cashOut: 200 });
    expect(sumMovements([])).toEqual({ cashIn: 0, cashOut: 0 });
  });

  it("rejects zero and fractional amounts", () => {
    expect(() => sumMovements([{ kind: "in", amount: 0 }])).toThrow(RangeError);
    expect(() => sumMovements([{ kind: "out", amount: 0.5 }])).toThrow();
  });
});
