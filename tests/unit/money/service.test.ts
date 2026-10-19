import { describe, expect, it } from "vitest";
import {
  evenShares,
  serviceChargeByRate,
  serviceChargeShares,
  serviceChargeWithin,
  type ChargeItem,
} from "@/lib/money";

const items: ChargeItem[] = [
  { gross: 1850, rateBp: 900 },
  { gross: 1295, rateBp: 900 },
  { gross: 650, rateBp: 2300 },
  { gross: 333, rateBp: 2300 },
];
const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);

describe("service charge", () => {
  it("charges the percentage once and shares it out exactly", () => {
    const s = serviceChargeShares(items, 1250);
    expect(sum(s)).toBe(Math.round((4128 * 1250) / 10000)); // 516
    expect(s.every((x) => x >= 0)).toBe(true);
  });
  it("is zero at 0% and for no items", () => {
    expect(serviceChargeShares(items, 0)).toEqual([0, 0, 0, 0]);
    expect(serviceChargeShares([], 1000)).toEqual([]);
  });
  it("splitting the bill never changes the total charge", () => {
    const whole = serviceChargeShares(items, 1250);
    const parts = [whole[0]! + whole[2]!, whole[1]! + whole[3]!];
    expect(sum(parts)).toBe(sum(whole));
  });
  it("groups by rate and splits VAT at that rate", () => {
    const rows = serviceChargeByRate(items, serviceChargeShares(items, 1250));
    expect(rows.map((r) => r.rateBp)).toEqual([2300, 900]);
    for (const r of rows) expect(r.net + r.vat).toBe(r.gross);
    expect(sum(rows.map((r) => r.gross))).toBe(516);
  });
  it("rejects bad input", () => {
    expect(() => serviceChargeShares(items, 2501)).toThrow(RangeError);
    expect(() => serviceChargeShares([{ gross: -1, rateBp: 0 }], 100)).toThrow(RangeError);
    expect(() => serviceChargeByRate(items, [1])).toThrow(RangeError);
  });
  it("random bills: shares sum to the rounded percentage", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 500; n++) {
      const its = Array.from({ length: 1 + Math.floor(rnd() * 8) }, () => ({
        gross: Math.floor(rnd() * 5000),
        rateBp: rnd() < 0.5 ? 900 : 2300,
      }));
      const bp = Math.floor(rnd() * 2501);
      const g = sum(its.map((i) => i.gross));
      const sh = serviceChargeShares(its, bp);
      expect(sum(sh)).toBe(Math.floor((g * bp + 5000) / 10000));
      sh.forEach((x, i) => expect(Math.abs(x - (its[i]!.gross * bp) / 10000)).toBeLessThan(1.01));
    }
  });
});

describe("evenShares", () => {
  it("adds up and differs by at most 1c", () => {
    const p = evenShares(10001, 3);
    expect(sum(p)).toBe(10001);
    expect(Math.max(...p) - Math.min(...p)).toBeLessThanOrEqual(1);
  });
  it("rejects a bad payer count", () => {
    expect(() => evenShares(100, 0)).toThrow(RangeError);
    expect(() => evenShares(100, 11)).toThrow(RangeError);
  });
});

describe("serviceChargeWithin", () => {
  it("accepts the rounded percentage and a share up to 1.5c from the exact one", () => {
    expect(serviceChargeWithin(5000, 1250, 625)).toBe(true); // exact
    expect(serviceChargeWithin(1004, 1250, 126)).toBe(true); // 125.5 exact
    expect(serviceChargeWithin(1004, 1250, 127)).toBe(true); // 1.5 away
    expect(serviceChargeWithin(1004, 1250, 128)).toBe(false); // 2.5 away
    expect(serviceChargeWithin(1004, 1250, 124)).toBe(true); // 1.5 away
    expect(serviceChargeWithin(1004, 1250, 123)).toBe(false);
  });
  it("never accepts a charge where the percentage is 0, and refuses bad values", () => {
    expect(serviceChargeWithin(5000, 0, 0)).toBe(true);
    expect(serviceChargeWithin(5000, 0, 1)).toBe(false);
    expect(serviceChargeWithin(0, 1250, 1)).toBe(false); // nothing to charge on
    expect(serviceChargeWithin(0, 1250, 0)).toBe(true);
    expect(serviceChargeWithin(-1, 1000, 0)).toBe(false);
    expect(serviceChargeWithin(100, 1000, -1)).toBe(false);
    expect(serviceChargeWithin(100, 2501, 25)).toBe(false);
    expect(serviceChargeWithin(100, -1, 0)).toBe(false);
    expect(() => serviceChargeWithin(1.5, 1000, 0)).toThrow(RangeError);
  });
});
