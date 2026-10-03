import { describe, expect, it } from "vitest";
import { TAX_CATEGORIES, categoryFor, findRateBp, localDate } from "@/lib/money";
import { IRISH_RATES } from "./irish-rates";

describe("seeded Irish rates", () => {
  it("covers every category", () => {
    expect(IRISH_RATES).toHaveLength(9);
    expect(new Set(IRISH_RATES.map((r) => r.code))).toEqual(new Set(TAX_CATEGORIES));
  });
});

describe("findRateBp", () => {
  it.each([
    ["STANDARD", "2026-01-01", 2300],
    ["REDUCED", "2026-07-01", 1350],
    ["SECOND_REDUCED", "2026-07-01", 900],
    ["ZERO", "2026-07-01", 0],
    ["LIVESTOCK", "2026-07-01", 480],
    ["CATERING", "2024-01-01", 1350],
    ["CATERING", "2026-06-30", 1350],
    ["CATERING", "2026-07-01", 900],
    ["CATERING", "2030-12-31", 900],
    ["HAIRDRESSING", "2026-06-30", 1350],
    ["HAIRDRESSING", "2026-07-01", 900],
  ] as const)("IE %s on %s = %i bp", (category, date, bp) =>
    expect(findRateBp(IRISH_RATES, "IE", category, date)).toBe(bp),
  );

  it("throws before the first seeded row", () =>
    expect(() => findRateBp(IRISH_RATES, "IE", "STANDARD", "2023-12-31")).toThrow(/0 IE STANDARD/));
  it("throws for an unknown country", () =>
    expect(() => findRateBp(IRISH_RATES, "GB", "STANDARD", "2026-07-01")).toThrow(/0 GB STANDARD/));
  it("throws when cached rows overlap instead of picking one", () => {
    const dup = {
      country: "IE",
      code: "STANDARD",
      rateBp: 2100,
      validFrom: "2026-01-01",
      validTo: null,
    };
    expect(() => findRateBp([...IRISH_RATES, dup], "IE", "STANDARD", "2026-07-01")).toThrow(
      /2 IE STANDARD/,
    );
  });
  it.each(["2026-7-1", "01/07/2026", "2026-07-01T00:00:00Z"])("rejects date %s", (date) =>
    expect(() => findRateBp(IRISH_RATES, "IE", "STANDARD", date)).toThrow(RangeError),
  );
});

describe("localDate", () => {
  it.each([
    ["2026-06-30T22:59:59Z", "Europe/Dublin", "2026-06-30"], // 23:59 IST
    ["2026-06-30T23:30:00Z", "Europe/Dublin", "2026-07-01"], // 00:30 IST: new catering rate
    ["2026-12-31T23:30:00Z", "Europe/Dublin", "2026-12-31"], // GMT in winter
    ["2026-06-30T23:30:00Z", "UTC", "2026-06-30"],
  ])("%s in %s is %s", (iso, tz, date) => expect(localDate(new Date(iso), tz)).toBe(date));
});

describe("categoryFor", () => {
  const sandwich = { taxCategory: "CATERING", takeawayTaxCategory: "ZERO" } as const;
  const beer = { taxCategory: "STANDARD" } as const;
  const coffee = { taxCategory: "CATERING", takeawayTaxCategory: "CATERING" } as const;
  it.each([
    [sandwich, "eat_in", "CATERING"],
    [sandwich, "take_away", "ZERO"],
    [beer, "eat_in", "STANDARD"],
    [beer, "take_away", "STANDARD"],
    [coffee, "take_away", "CATERING"],
  ] as const)("%j %s → %s", (product, mode, expected) =>
    expect(categoryFor(product, mode)).toBe(expected),
  );
  it("refuses CATERING take-away without an explicit mapping", () => {
    expect(categoryFor({ taxCategory: "CATERING" }, "eat_in")).toBe("CATERING");
    expect(() => categoryFor({ taxCategory: "CATERING" }, "take_away")).toThrow(
      /takeawayTaxCategory/,
    );
  });
});
