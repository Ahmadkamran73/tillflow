// @vitest-environment node
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { toCsv, toXlsx } from "@/lib/export/tabular";
import { addDays, parseReportParams, presets, reportParams } from "@/lib/reports/params";
import { buildTable, reportsFor, REPORTS, type SummaryRow } from "@/lib/reports/registry";

const row = (over: Partial<SummaryRow>): SummaryRow => ({
  day: null,
  key: "k",
  label: "L",
  sales_count: 0,
  qty: 0,
  gross_cents: 0,
  net_cents: 0,
  vat_cents: 0,
  discount_cents: 0,
  tips_cents: 0,
  refund_count: 0,
  refund_qty: 0,
  refund_gross_cents: 0,
  refund_net_cents: 0,
  refund_vat_cents: 0,
  ...over,
});

describe("report parameters", () => {
  it("moves calendar days without a clock", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2028-03-01", -1)).toBe("2028-02-29");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("accepts real, ordered, bounded ranges only", () => {
    expect(reportParams.safeParse({ from: "2026-10-01", to: "2026-10-14" }).success).toBe(true);
    expect(reportParams.safeParse({ from: "2026-10-14", to: "2026-10-01" }).success).toBe(false);
    expect(reportParams.safeParse({ from: "2026-02-30", to: "2026-03-01" }).success).toBe(false);
    expect(reportParams.safeParse({ from: "2026-1-1", to: "2026-03-01" }).success).toBe(false);
    expect(reportParams.safeParse({ from: "2025-10-13", to: "2026-10-14" }).success).toBe(false);
    expect(reportParams.safeParse({ from: "2025-10-14", to: "2026-10-14" }).success).toBe(true);
    expect(
      reportParams.safeParse({ from: "2026-10-01", to: "2026-10-02", q: "x".repeat(61) }).success,
    ).toBe(false);
  });

  it("falls back to the last 30 days when the URL is missing or wrong", () => {
    const today = "2026-10-14";
    expect(parseReportParams({}, today)).toEqual({ from: "2026-09-15", to: today });
    expect(parseReportParams({ from: "nonsense", to: today }, today)).toEqual({
      from: "2026-09-15",
      to: today,
    });
    expect(parseReportParams({ from: "2026-10-01", to: "2026-10-05", q: "ab" }, today)).toEqual({
      from: "2026-10-01",
      to: "2026-10-05",
      q: "ab",
    });
  });

  it("offers the Irish two-month VAT periods", () => {
    expect(presets("2026-10-14").vatPeriod).toEqual({ from: "2026-09-01", to: "2026-10-31" });
    expect(presets("2026-10-14").lastVatPeriod).toEqual({ from: "2026-07-01", to: "2026-08-31" });
    expect(presets("2026-01-05").vatPeriod).toEqual({ from: "2026-01-01", to: "2026-02-28" });
    expect(presets("2026-01-05").lastVatPeriod).toEqual({ from: "2025-11-01", to: "2025-12-31" });
    expect(presets("2028-02-10").vatPeriod).toEqual({ from: "2028-01-01", to: "2028-02-29" });
    expect(presets("2026-10-14").lastMonth).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presets("2026-01-14").lastMonth).toEqual({ from: "2025-12-01", to: "2025-12-31" });
  });
});

describe("report tables", () => {
  it("shows each report only to the business types it is for", () => {
    expect(reportsFor("general")).not.toContain("serials");
    expect(reportsFor("electronics")).toEqual(
      expect.arrayContaining(["serials", "sales-by-brand"]),
    );
    expect(reportsFor("clothing")).toContain("sales-by-size-colour");
    expect(reportsFor("restaurant")).toEqual(expect.arrayContaining(["covers", "tips"]));
    expect(reportsFor("cafe")).toContain("tips");
    expect(reportsFor("cafe")).not.toContain("covers");
    for (const type of ["general", "electronics", "clothing", "cafe", "restaurant"] as const) {
      expect(reportsFor(type)).toEqual(expect.arrayContaining(["sales-by-day", "vat", "payments"]));
    }
    expect(REPORTS).toHaveLength(12);
  });

  it("adds up VAT by rate with refunds beside sales, highest rate first", () => {
    const t = buildTable(
      "vat",
      {
        summary: [
          row({ key: "0", label: "0%", net_cents: 500, vat_cents: 0, gross_cents: 500 }),
          row({
            key: "2300",
            label: "23%",
            net_cents: 569,
            vat_cents: 131,
            gross_cents: 700,
            refund_net_cents: 284,
            refund_vat_cents: 66,
            refund_gross_cents: 350,
          }),
        ],
      },
      "Total",
      "Europe/Dublin",
    );
    expect(t.rows[0]).toEqual(["23%", 569, 131, 700, 284, 66, 350, 65]);
    expect(t.rows[1]![0]).toBe("0%");
    expect(t.totals).toEqual(["Total", 1069, 131, 1200, 284, 66, 350, 65]);
  });

  it("sales by day: takings, VAT, refunds and what is left", () => {
    const t = buildTable(
      "sales-by-day",
      {
        summary: [
          row({
            day: "2026-10-13",
            sales_count: 2,
            gross_cents: 1050,
            vat_cents: 196,
            refund_gross_cents: 350,
          }),
          row({
            day: "2026-10-14",
            sales_count: 1,
            gross_cents: 350,
            vat_cents: 65,
            discount_cents: 20,
          }),
        ],
      },
      "Total",
      "Europe/Dublin",
    );
    expect(t.rows[0]).toEqual(["13/10/2026", 2, 1050, 196, 0, 350, 700]);
    expect(t.totals).toEqual(["Total", 3, 1400, 261, 20, 350, 1050]);
  });

  it("product reports are sorted by takings and carry returns", () => {
    const t = buildTable(
      "sales-by-product",
      {
        summary: [
          row({ label: "Tea", qty: 2, gross_cents: 700, refund_qty: 1, refund_gross_cents: 350 }),
          row({ label: "Cake", qty: 1, gross_cents: 900 }),
        ],
      },
      "Total",
      "Europe/Dublin",
    );
    expect(t.rows.map((r) => r[0])).toEqual(["Cake", "Tea"]);
    expect(t.rows[1]).toEqual(["Tea", 2, 700, 0, 0, 1, 350, 350]);
  });

  it("spend per cover is rounded half up from stored cents, and 0 with no covers", () => {
    const t = buildTable(
      "covers",
      {
        covers: [
          { day: "2026-10-13", tabs: 1, covers: 3, sales_cents: 1000 },
          { day: "2026-10-14", tabs: 1, covers: 0, sales_cents: 500 },
        ],
      },
      "Total",
      "Europe/Dublin",
    );
    expect(t.rows[0]).toEqual(["13/10/2026", 1, 3, 1000, 333]);
    expect(t.rows[1]![4]).toBe(0);
    expect(t.totals).toEqual(["Total", 2, 3, 1500, 500]);
  });

  it("serials are listed with the till and receipt number and have no totals", () => {
    const t = buildTable(
      "serials",
      {
        serials: [
          {
            serial: "IMEI-1",
            name: "Phone",
            receipt_seq: 42,
            register_name: "Till 1",
            completed_at: "2026-10-14T10:00:00Z",
            returned: true,
          },
        ],
      },
      "Total",
      "Europe/Dublin",
    );
    expect(t.totals).toBeNull();
    expect(t.rows[0]).toEqual(["14/10/2026, 11:00", "IMEI-1", "Phone", "Till 1 · 000042", "Yes"]);
  });

  it("an empty report has no totals row", () => {
    expect(buildTable("sales-by-day", { summary: [] }, "Total", "Europe/Dublin").totals).toBeNull();
  });
});

describe("exports", () => {
  const evil = '=HYPERLINK("http://x")';
  const table = buildTable(
    "sales-by-product",
    {
      summary: [
        row({ label: evil, qty: 1, gross_cents: 1230 }),
        row({ label: "+cmd|' /C calc'!A0", qty: 1, gross_cents: -500 }),
        row({ label: "@SUM(1)", qty: 1, gross_cents: 100 }),
        row({ label: "-2+3", qty: 1, gross_cents: 100 }),
        row({ label: 'Tea, "large"', qty: 1, gross_cents: 100 }),
      ],
    },
    "Total",
    "Europe/Dublin",
  );

  it("escapes cells that start with = + - @ in CSV, leaves numbers (even negative) alone", () => {
    const csv = toCsv(table);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).trim().split("\r\n");
    expect(lines[0]).toBe(
      "Product,Quantity,Takings,Net (ex VAT),VAT,Returned,Refunded,After refunds",
    );
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")",1,12.30,`);
    expect(csv).toContain("'+cmd|' /C calc'!A0,1,-5.00,");
    expect(csv).toContain("'@SUM(1),");
    expect(csv).toContain("'-2+3,");
    expect(csv).toContain(`"Tea, ""large""",`);
    // The negative money cell is a plain number, not text.
    expect(csv).toContain(",-5.00,");
    expect(csv).not.toContain(",'-5.00");
  });

  it("writes Excel text cells formula-safe and money as numbers", async () => {
    const buf = await toXlsx(table, {
      shop: "=Shop",
      range: "01/10/2026 - 14/10/2026",
      madeAt: "now",
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const texts: unknown[] = [];
    let moneyCell: unknown;
    ws.eachRow((r) => {
      r.eachCell((c) => {
        if (typeof c.value === "string") texts.push(c.value);
        if (c.value === 12.3) moneyCell = c.value;
      });
    });
    expect(texts).toContain("'=Shop · Sales by product");
    expect(texts).toContain('\'=HYPERLINK("http://x")');
    expect(texts).toContain("'@SUM(1)");
    expect(texts.some((v) => typeof v === "string" && v.startsWith("="))).toBe(false);
    expect(moneyCell).toBe(12.3);
  });
});
