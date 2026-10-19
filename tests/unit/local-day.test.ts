import { describe, expect, it } from "vitest";
import { startOfLocalDay } from "@/lib/local-day";

describe("startOfLocalDay", () => {
  it("is midnight in Dublin: UTC in winter, an hour earlier in summer (IST)", () => {
    expect(startOfLocalDay(new Date("2026-01-15T13:00:00Z"), "Europe/Dublin").toISOString()).toBe(
      "2026-01-15T00:00:00.000Z",
    );
    expect(startOfLocalDay(new Date("2026-10-05T13:32:00Z"), "Europe/Dublin").toISOString()).toBe(
      "2026-10-04T23:00:00.000Z",
    );
  });
  it("belongs to the shop-local day, not the UTC day", () => {
    // 23:30 UTC on 4 Oct is already 5 Oct (00:30) in Dublin.
    expect(startOfLocalDay(new Date("2026-10-04T23:30:00Z"), "Europe/Dublin").toISOString()).toBe(
      "2026-10-04T23:00:00.000Z",
    );
  });
});
