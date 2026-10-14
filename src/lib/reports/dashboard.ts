import "server-only";
import type { BusinessType, DashboardTile } from "@/config/business-type-presets";
import { addDays } from "./params";
import { loadRows } from "./data";
import type { SummaryRow } from "./registry";

export type DayFigures = {
  takingsCents: number;
  transactions: number;
  vatCents: number;
  tipsCents: number;
};
export type TopRow = { label: string; qty: number; grossCents: number };

export type DashboardData = {
  today: DayFigures;
  lastWeek: DayFigures;
  /** The same weekday a week ago (`YYYY-MM-DD`), for the "Up on last Tuesday" text. */
  lastWeekDay: string;
  top: TopRow[];
  hours: { hour: string; grossCents: number; sales: number }[];
  brands: TopRow[];
  sizes: TopRow[];
  serialsToday: number;
  covers: { covers: number; spendPerCoverBase: number } | null;
  /** True when no sale was recorded in the last 7 days (shows the first-sale panel). */
  quiet: boolean;
};

const zero: DayFigures = { takingsCents: 0, transactions: 0, vatCents: 0, tipsCents: 0 };

/** Sales less refunds for one summary row, all from stored cents. */
const figures = (r: SummaryRow | undefined): DayFigures =>
  r
    ? {
        takingsCents: r.gross_cents - r.refund_gross_cents,
        transactions: r.sales_count,
        vatCents: r.vat_cents - r.refund_vat_cents,
        tipsCents: r.tips_cents,
      }
    : zero;

const top = (rows: SummaryRow[] | undefined, n = 5): TopRow[] =>
  [...(rows ?? [])]
    .filter((r) => r.gross_cents > 0)
    .sort((a, b) => b.gross_cents - a.gross_cents || a.label.localeCompare(b.label))
    .slice(0, n)
    .map((r) => ({ label: r.label, qty: r.qty, grossCents: r.gross_cents }));

/**
 * What the dashboard shows, read only from the pre-aggregated summary (never the raw sales):
 * today against the same weekday last week, the best sellers of the last 7 days, and the tiles
 * the shop's business type asks for.
 */
export async function loadDashboard(
  orgId: string,
  today: string,
  type: BusinessType,
  tiles: readonly DashboardTile[],
): Promise<DashboardData> {
  const lastWeekDay = addDays(today, -7);
  const week = { from: addDays(today, -6), to: today };
  const two = { from: lastWeekDay, to: today };
  const day = { from: today, to: today };
  const want = (t: DashboardTile) => tiles.includes(t);

  const [days, products, hours, brands, sizes, serials, covers] = await Promise.all([
    loadRows(orgId, "sales-by-day", two),
    loadRows(orgId, "sales-by-product", week),
    want("salesByHour") ? loadRows(orgId, "sales-by-hour", day) : null,
    want("salesByBrand") ? loadRows(orgId, "sales-by-brand", week) : null,
    want("salesBySizeColour") ? loadRows(orgId, "sales-by-size-colour", week) : null,
    want("serialsSold") ? loadRows(orgId, "serials", day) : null,
    type === "restaurant" && (want("covers") || want("spendPerCover"))
      ? loadRows(orgId, "covers", day)
      : null,
  ]);

  const byDay = new Map((days.summary ?? []).map((r) => [r.day, r]));
  const coverRow = covers?.covers?.[0];
  return {
    today: figures(byDay.get(today)),
    lastWeek: figures(byDay.get(lastWeekDay)),
    lastWeekDay,
    top: top(products.summary),
    hours: (hours?.summary ?? [])
      .map((r) => ({ hour: r.label, grossCents: r.gross_cents, sales: r.sales_count }))
      .sort((a, b) => b.grossCents - a.grossCents)
      .slice(0, 3),
    brands: top(brands?.summary),
    sizes: top(sizes?.summary),
    serialsToday: serials?.serials?.length ?? 0,
    covers: coverRow ? { covers: coverRow.covers, spendPerCoverBase: coverRow.sales_cents } : null,
    quiet: (products.summary ?? []).length === 0 && byDay.size === 0,
  };
}
