// @vitest-environment node
/**
 * Writes sample report exports (VAT report, a product report with hostile names, a daily report)
 * as CSV, XLSX and PDF so they can be opened by hand in Excel or LibreOffice (procedure:
 * docs/specs/reports.md, "Compatibility check"). Skipped unless SAMPLE_EXPORT_DIR is set:
 *
 *   SAMPLE_EXPORT_DIR=./sample-exports pnpm exec vitest run tests/unit/sample-exports.test.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { toPdf } from "@/lib/export/pdf";
import { toCsv, toXlsx } from "@/lib/export/tabular";
import { t } from "@/lib/i18n";
import { buildTable, type ReportId, type SummaryRow } from "@/lib/reports/registry";

const out = process.env.SAMPLE_EXPORT_DIR;

const row = (o: Partial<SummaryRow>): SummaryRow => ({
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
  ...o,
});

const samples: { id: ReportId; name: string; rows: SummaryRow[] }[] = [
  {
    id: "vat",
    name: "vat",
    rows: [
      row({
        key: "2300",
        label: "23%",
        net_cents: 1_234_567,
        vat_cents: 283_950,
        gross_cents: 1_518_517,
        refund_net_cents: 10_000,
        refund_vat_cents: 2_300,
        refund_gross_cents: 12_300,
      }),
      row({
        key: "1350",
        label: "13.5%",
        net_cents: 88_000,
        vat_cents: 11_880,
        gross_cents: 99_880,
      }),
      row({
        key: "900",
        label: "9%",
        net_cents: 450_000,
        vat_cents: 40_500,
        gross_cents: 490_500,
        refund_net_cents: 500_000,
        refund_vat_cents: 45_000,
        refund_gross_cents: 545_000,
      }),
      row({ key: "0", label: "0%", net_cents: 12_345, gross_cents: 12_345 }),
    ],
  },
  {
    id: "sales-by-product",
    name: "products-hostile",
    rows: [
      row({ label: '=HYPERLINK("http://example.com","click")', qty: 3, gross_cents: 1230 }),
      row({ label: "+1+1", qty: 1, gross_cents: 500 }),
      row({ label: "-2+3", qty: 1, gross_cents: 100 }),
      row({ label: "@SUM(A1:A9)", qty: 1, gross_cents: 100 }),
      row({
        label: 'Café crème, "large" € ü',
        qty: 2,
        gross_cents: 900,
        refund_qty: 1,
        refund_gross_cents: 450,
      }),
      row({ label: "Negative net", qty: 1, gross_cents: 100, refund_gross_cents: 700 }),
    ],
  },
  {
    id: "sales-by-day",
    name: "days",
    rows: [
      row({
        day: "2026-10-12",
        sales_count: 12,
        gross_cents: 45_050,
        vat_cents: 8_420,
        discount_cents: 500,
      }),
      row({
        day: "2026-10-13",
        sales_count: 9,
        gross_cents: 30_025,
        vat_cents: 5_600,
        refund_gross_cents: 1_200,
      }),
      row({ day: "2026-10-14", sales_count: 3, gross_cents: 10_000, vat_cents: 1_870 }),
    ],
  },
];

const meta = {
  shop: '=Corner Shop "Test"',
  range: "01/10/2026 - 14/10/2026",
  madeAt: "14 Oct 2026, 16:00",
};


describe.skipIf(!out)("sample exports for a manual Excel / LibreOffice check", () => {
  it("writes CSV, XLSX and PDF for three reports", async () => {
    mkdirSync(out!, { recursive: true });
    for (const s of samples) {
      const table = buildTable(s.id, { summary: s.rows }, t("reports.total"), "Europe/Dublin");
      const note = { ...meta, note: t(s.id === "vat" ? "reports.note.vat" : "reports.note.refunds") };
      writeFileSync(join(out!, `${s.name}.csv`), toCsv(table));
      writeFileSync(join(out!, `${s.name}.xlsx`), await toXlsx(table, note));
      const pdf = await toPdf(table, note);
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      writeFileSync(join(out!, `${s.name}.pdf`), pdf);
    }
  });
});
