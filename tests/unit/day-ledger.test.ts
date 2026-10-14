// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cash5, euro, expected, localParts, offsetZone, roundHalf, vatIn } from "../e2e/day/ledger";

// The whole-day e2e tests judge the app against this calculator, so the calculator is checked here
// against worked examples done by hand.

describe("independent VAT arithmetic", () => {
  it("rounds half away from zero with integers", () => {
    expect(roundHalf(5, 2)).toBe(3); // 2.5
    expect(roundHalf(-5, 2)).toBe(-3);
    expect(roundHalf(7, 3)).toBe(2); // 2.33
    expect(roundHalf(8, 3)).toBe(3); // 2.67
    expect(roundHalf(0, 5)).toBe(0);
  });

  it("finds the VAT inside a gross amount (by hand: 12.34 at 23% = 2.31)", () => {
    expect(vatIn(1234, 2300)).toBe(231);
    expect(vatIn(200, 2300)).toBe(37);
    expect(vatIn(2000, 1350)).toBe(238);
    expect(vatIn(500, 900)).toBe(41);
    expect(vatIn(2000, 900)).toBe(165);
    expect(vatIn(135, 0)).toBe(0);
  });

  it("rounds cash to 5c, halves up", () => {
    expect(cash5(1584)).toBe(1585);
    expect(cash5(1468)).toBe(1470);
    expect(cash5(1502)).toBe(1500);
    expect(cash5(1500)).toBe(1500);
    expect(cash5(1503)).toBe(1505);
  });

  it("formats euros", () => {
    expect(euro(1234)).toBe("€12.34");
    expect(euro(-45)).toBe("-€0.45");
    expect(euro(1518517)).toBe("€15,185.17");
  });
});

describe("the day ledger", () => {
  const sales = [
    {
      key: "s1",
      lines: [
        { name: "Tea", gross: 1234, rateBp: 2300 },
        { name: "Candle", gross: 2000, rateBp: 1350 },
      ],
      deposit: 15,
      // cash share 3249 rounds to 3250
      pays: [{ method: "cash" as const, amount: 3250 }],
    },
  ];

  it("adds up VAT by rate, tenders and the drawer", () => {
    const e = expected(sales, [], { float: 10000, counted: 13250 });
    expect(e.vat).toBe(231 + 238);
    expect(e.byRate.get(2300)).toEqual({ gross: 1234, vat: 231, net: 1003 });
    expect(e.tender.cash).toBe(3250);
    expect(e.expectedCash).toBe(13250);
    expect(e.overShort).toBe(0);
  });

  it("returns a share of a line at its own rate and counts credit as returned", () => {
    const e = expected(
      sales,
      [
        {
          sale: "s1",
          lines: [{ sale: "s1", line: 1, units: 1, of: 2 }],
          legs: [{ method: "cash", amount: 1000 }],
        },
      ],
      { float: 10000, counted: 12200 },
    );
    expect(e.refByRate.get(1350)).toEqual({ gross: 1000, vat: 119, net: 881 });
    expect(e.refunds.value).toBe(1000);
    expect(e.expectedCash).toBe(10000 + 3250 - 1000);
    expect(e.overShort).toBe(12200 - 12250);
    expect(e.netTakings).toBe(3250 - 1000);
  });

  it("refuses a scenario whose cash does not add up", () => {
    expect(() =>
      expected([{ ...sales[0]!, pays: [{ method: "cash", amount: 3300 }] }], [], {
        float: 0,
        counted: 0,
      }),
    ).toThrow(/cash 3300/);
  });
});

describe("shop-local days", () => {
  it("picks a zone whose local day is not the UTC day", () => {
    // Every minute of a day (in steps of 7): a zone is always found, it is on another day than
    // UTC, and it is not within the last hour of its own day.
    for (let m = 0; m < 24 * 60; m += 7) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      const iso = `2026-10-14T${hh}:${mm}:00Z`;
      const now = new Date(iso);
      const { day, hour } = localParts(now, offsetZone(now));
      expect(day).not.toBe(iso.slice(0, 10));
      expect(hour).toBeLessThan(23);
    }
  });

  it("reads the local day and hour", () => {
    expect(localParts(new Date("2026-10-14T23:30:00Z"), "Pacific/Kiritimati")).toEqual({
      day: "2026-10-15",
      hour: 13,
    });
    expect(localParts(new Date("2026-10-14T05:30:00Z"), "Pacific/Pago_Pago")).toEqual({
      day: "2026-10-13",
      hour: 18,
    });
  });
});
