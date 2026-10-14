import type { BusinessType } from "@/config/business-type-presets";
import type { MessageKey } from "@/lib/i18n";
import { roundHalfUp } from "@/lib/money";
import { withTotals, type Cell, type Column, type ReportTable } from "./table";

/** A row of public.report_summary (bigint columns arrive as numbers: a shop's cents fit easily). */
export type SummaryRow = {
  day: string | null;
  key: string;
  label: string;
  sales_count: number;
  qty: number;
  gross_cents: number;
  net_cents: number;
  vat_cents: number;
  discount_cents: number;
  tips_cents: number;
  refund_count: number;
  refund_qty: number;
  refund_gross_cents: number;
  refund_net_cents: number;
  refund_vat_cents: number;
};
export type SerialRow = {
  serial: string;
  name: string;
  receipt_seq: number;
  register_name: string;
  completed_at: string;
  returned: boolean;
};
export type CoversRow = { day: string; tabs: number; covers: number; sales_cents: number };

export const REPORTS = [
  "sales-by-day",
  "sales-by-product",
  "sales-by-category",
  "sales-by-staff",
  "sales-by-hour",
  "vat",
  "payments",
  "tips",
  "covers",
  "serials",
  "sales-by-brand",
  "sales-by-size-colour",
] as const;
export type ReportId = (typeof REPORTS)[number];

export type Source =
  { from: "summary"; dim: string; byDay: boolean } | { from: "serials" } | { from: "covers" };

type Def = {
  title: MessageKey;
  blurb: MessageKey;
  source: Source;
  /** Business types that see it; omitted means all. */
  types?: BusinessType[];
};

export const REPORT_DEFS: Record<ReportId, Def> = {
  "sales-by-day": {
    title: "report.salesByDay",
    blurb: "report.salesByDay.blurb",
    source: { from: "summary", dim: "total", byDay: true },
  },
  "sales-by-product": {
    title: "report.salesByProduct",
    blurb: "report.salesByProduct.blurb",
    source: { from: "summary", dim: "product", byDay: false },
  },
  "sales-by-category": {
    title: "report.salesByCategory",
    blurb: "report.salesByCategory.blurb",
    source: { from: "summary", dim: "category", byDay: false },
  },
  "sales-by-staff": {
    title: "report.salesByStaff",
    blurb: "report.salesByStaff.blurb",
    source: { from: "summary", dim: "staff", byDay: false },
  },
  "sales-by-hour": {
    title: "report.salesByHour",
    blurb: "report.salesByHour.blurb",
    source: { from: "summary", dim: "hour", byDay: false },
  },
  vat: {
    title: "report.vat",
    blurb: "report.vat.blurb",
    source: { from: "summary", dim: "vat_rate", byDay: false },
  },
  payments: {
    title: "report.payments",
    blurb: "report.payments.blurb",
    source: { from: "summary", dim: "tender", byDay: false },
  },
  tips: {
    title: "report.tips",
    blurb: "report.tips.blurb",
    source: { from: "summary", dim: "total", byDay: true },
    types: ["cafe", "restaurant"],
  },
  covers: {
    title: "report.covers",
    blurb: "report.covers.blurb",
    source: { from: "covers" },
    types: ["restaurant"],
  },
  serials: {
    title: "report.serials",
    blurb: "report.serials.blurb",
    source: { from: "serials" },
    types: ["electronics"],
  },
  "sales-by-brand": {
    title: "report.salesByBrand",
    blurb: "report.salesByBrand.blurb",
    source: { from: "summary", dim: "brand", byDay: false },
    types: ["electronics"],
  },
  "sales-by-size-colour": {
    title: "report.salesBySizeColour",
    blurb: "report.salesBySizeColour.blurb",
    source: { from: "summary", dim: "size_colour", byDay: false },
    types: ["clothing"],
  },
};

export const isReportId = (s: string): s is ReportId => (REPORTS as readonly string[]).includes(s);

export const reportsFor = (type: BusinessType): ReportId[] =>
  REPORTS.filter((id) => !REPORT_DEFS[id].types || REPORT_DEFS[id].types.includes(type));

const col = (label: MessageKey, kind: Column["kind"]): Column => ({ label, kind });
const byGrossDesc = (a: SummaryRow, b: SummaryRow) =>
  b.gross_cents - a.gross_cents || a.label.localeCompare(b.label);
/** Sales less what was paid back, both from stored cents. */
const net = (r: SummaryRow) => r.gross_cents - r.refund_gross_cents;

/** `YYYY-MM-DD` as a day is usually written in Ireland. */
export const dayLabel = (d: string) => d.split("-").reverse().join("/");

/** The line-level reports (product, category, brand, size/colour) share their columns. */
function lineTable(rows: SummaryRow[], title: MessageKey, total: string, first: MessageKey) {
  const columns = [
    col(first, "text"),
    col("report.col.qty", "int"),
    col("report.col.gross", "money"),
    col("report.col.net", "money"),
    col("report.col.vat", "money"),
    col("report.col.refundQty", "int"),
    col("report.col.refunded", "money"),
    col("report.col.afterRefunds", "money"),
  ];
  const cells = [...rows]
    .sort(byGrossDesc)
    .map((r): Cell[] => [
      r.label,
      r.qty,
      r.gross_cents,
      r.net_cents,
      r.vat_cents,
      r.refund_qty,
      r.refund_gross_cents,
      net(r),
    ]);
  return withTotals(title, columns, cells, total);
}

/**
 * Turns database rows into the table the screen and every export print. Pure: the same rows always
 * give the same table, so the tests pin every report. `total` is the localised word "Total".
 */
export function buildTable(
  id: ReportId,
  data: { summary?: SummaryRow[]; serials?: SerialRow[]; covers?: CoversRow[] },
  total: string,
  timeZone: string,
): ReportTable {
  const title = REPORT_DEFS[id].title;
  const rows = data.summary ?? [];
  switch (id) {
    case "sales-by-day": {
      const columns = [
        col("report.col.date", "text"),
        col("report.col.sales", "int"),
        col("report.col.gross", "money"),
        col("report.col.vat", "money"),
        col("report.col.discounts", "money"),
        col("report.col.refunded", "money"),
        col("report.col.afterRefunds", "money"),
      ];
      const cells = rows.map((r): Cell[] => [
        dayLabel(r.day ?? ""),
        r.sales_count,
        r.gross_cents,
        r.vat_cents,
        r.discount_cents,
        r.refund_gross_cents,
        net(r),
      ]);
      return withTotals(title, columns, cells, total);
    }
    case "sales-by-product":
      return lineTable(rows, title, total, "report.col.product");
    case "sales-by-category":
      return lineTable(rows, title, total, "report.col.category");
    case "sales-by-brand":
      return lineTable(rows, title, total, "report.col.brand");
    case "sales-by-size-colour":
      return lineTable(rows, title, total, "report.col.sizeColour");
    case "sales-by-staff": {
      const columns = [
        col("report.col.staff", "text"),
        col("report.col.sales", "int"),
        col("report.col.gross", "money"),
        col("report.col.tips", "money"),
        col("report.col.refundCount", "int"),
        col("report.col.refunded", "money"),
      ];
      const cells = [...rows]
        .sort(byGrossDesc)
        .map((r): Cell[] => [
          r.label,
          r.sales_count,
          r.gross_cents,
          r.tips_cents,
          r.refund_count,
          r.refund_gross_cents,
        ]);
      return withTotals(title, columns, cells, total);
    }
    case "sales-by-hour": {
      const columns = [
        col("report.col.hour", "text"),
        col("report.col.sales", "int"),
        col("report.col.gross", "money"),
        col("report.col.vat", "money"),
        col("report.col.refundCount", "int"),
        col("report.col.refunded", "money"),
      ];
      const cells = rows.map((r): Cell[] => [
        r.label,
        r.sales_count,
        r.gross_cents,
        r.vat_cents,
        r.refund_count,
        r.refund_gross_cents,
      ]);
      return withTotals(title, columns, cells, total);
    }
    case "vat": {
      // Sales and refunds side by side, then the VAT left to pay. Every figure is a sum of the
      // net / VAT / gross stored on the lines at the rate in force that day: nothing is recalculated.
      const columns = [
        col("report.col.rate", "text"),
        col("report.col.net", "money"),
        col("report.col.vat", "money"),
        col("report.col.gross", "money"),
        col("report.col.refundNet", "money"),
        col("report.col.refundVat", "money"),
        col("report.col.refundGross", "money"),
        col("report.col.netVatDue", "money"),
      ];
      const cells = [...rows]
        .sort((a, b) => Number(b.key) - Number(a.key))
        .map((r): Cell[] => [
          r.label,
          r.net_cents,
          r.vat_cents,
          r.gross_cents,
          r.refund_net_cents,
          r.refund_vat_cents,
          r.refund_gross_cents,
          r.vat_cents - r.refund_vat_cents,
        ]);
      return withTotals(title, columns, cells, total);
    }
    case "payments": {
      const columns = [
        col("report.col.paymentType", "text"),
        col("report.col.payments", "int"),
        col("report.col.taken", "money"),
        col("report.col.tips", "money"),
        col("report.col.refundCount", "int"),
        col("report.col.paidBack", "money"),
        col("report.col.afterRefunds", "money"),
      ];
      const cells = [...rows]
        .sort(byGrossDesc)
        .map((r): Cell[] => [
          r.label,
          r.sales_count,
          r.gross_cents,
          r.tips_cents,
          r.refund_count,
          r.refund_gross_cents,
          net(r),
        ]);
      return withTotals(title, columns, cells, total);
    }
    case "tips": {
      const columns = [
        col("report.col.date", "text"),
        col("report.col.sales", "int"),
        col("report.col.tips", "money"),
      ];
      const cells = rows.map((r): Cell[] => [dayLabel(r.day ?? ""), r.sales_count, r.tips_cents]);
      return withTotals(title, columns, cells, total);
    }
    case "covers": {
      const columns = [
        col("report.col.date", "text"),
        col("report.col.tabs", "int"),
        col("report.col.covers", "int"),
        col("report.col.fromTabs", "money"),
        col("report.col.perCover", "money"),
      ];
      const perCover = (cents: number, covers: number) =>
        covers > 0 ? roundHalfUp(cents, covers) : 0;
      const cells = (data.covers ?? []).map((r): Cell[] => [
        dayLabel(r.day),
        r.tabs,
        r.covers,
        r.sales_cents,
        perCover(r.sales_cents, r.covers),
      ]);
      const t = withTotals(title, columns, cells, total, [4]);
      if (t.totals) t.totals[4] = perCover(t.totals[3] as number, t.totals[2] as number);
      return t;
    }
    case "serials": {
      const columns = [
        col("report.col.when", "text"),
        col("report.col.serial", "text"),
        col("report.col.item", "text"),
        col("report.col.receipt", "text"),
        col("report.col.returned", "text"),
      ];
      const when = new Intl.DateTimeFormat("en-IE", {
        dateStyle: "short",
        timeStyle: "short",
        timeZone,
      });
      const cells = (data.serials ?? []).map((r): Cell[] => [
        when.format(new Date(r.completed_at)),
        r.serial,
        r.name,
        `${r.register_name} · ${String(r.receipt_seq).padStart(6, "0")}`,
        r.returned ? "Yes" : "",
      ]);
      return { title, columns, rows: cells, totals: null };
    }
  }
}
