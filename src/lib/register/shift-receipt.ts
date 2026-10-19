import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import type { ShiftSummary } from "./shift";

/**
 * The X- or Z-report as printer lines (32/42/48 columns). The totals come from the till's own
 * stored figures (see `summariseShift`); the server's Z, with VAT by rate, is in the back office.
 * Only amounts and the shop's names appear.
 */
export function shiftReportLines(
  args: {
    kind: "X" | "Z";
    businessName: string;
    tillName: string;
    timezone: string;
    openedAt: string;
    closedAt?: string;
    summary: ShiftSummary;
    countedCents?: number;
    overShortCents?: number;
  },
  cols: 32 | 42 | 48,
): string[] {
  const s = args.summary;
  const fmt = new Intl.DateTimeFormat("en-IE", {
    timeZone: args.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const when = (iso: string) => fmt.format(new Date(iso)).replace(",", "");
  const rule = "-".repeat(cols);
  const row = (left: string, right: string) => {
    const gap = Math.max(1, cols - left.length - right.length);
    return left + " ".repeat(gap) + right;
  };
  const centre = (text: string) =>
    " ".repeat(Math.max(0, Math.floor((cols - text.length) / 2))) + text;
  const signed = (c: number) => (c > 0 ? "+" : "") + formatCents(c);

  const lines = [
    centre(args.businessName),
    centre(`${t("shift.reportTitle", { kind: args.kind })} · ${args.tillName}`),
    rule,
    row(t("shift.menuTitle"), ""),
    row(t("shift.openedAt"), when(args.openedAt)),
    ...(args.closedAt ? [row(t("shift.closedAt"), when(args.closedAt))] : []),
    rule,
    row(`${t("shift.sales")} (${s.saleCount})`, formatCents(s.salesCents)),
    row(t("shift.vat"), formatCents(s.vatCents)),
    row(t("shift.cashSales"), formatCents(s.cashSalesCents)),
    row(t("shift.cardSales"), formatCents(s.cardSalesCents)),
    row(t("shift.tips"), formatCents(s.tipsCents)),
    row(`${t("shift.refunds")} (${s.refundCount})`, formatCents(s.refundCents)),
    row(t("shift.cashRefunds"), formatCents(s.cashRefundsCents)),
    row(t("shift.cardRefunds"), formatCents(s.cardRefundsCents)),
    rule,
    row(t("shift.floatLabel"), formatCents(s.floatCents)),
    row(t("shift.cashSales"), formatCents(s.cashSalesCents)),
    row(t("shift.cashInLabel"), formatCents(s.cashInCents)),
    row(t("shift.cashOutLabel"), "-" + formatCents(s.cashOutCents)),
    row(t("shift.cashRefunds"), "-" + formatCents(s.cashRefundsCents)),
    row(t("shift.expected"), formatCents(s.expectedCents)),
  ];
  if (args.countedCents !== undefined && args.overShortCents !== undefined) {
    lines.push(
      row(t("shift.countedLabel"), formatCents(args.countedCents)),
      row(t("shift.overShort"), signed(args.overShortCents)),
    );
  }
  if (s.rejectedCount > 0) lines.push(rule, t("shift.waiting", { count: s.rejectedCount }));
  if (args.kind === "Z") lines.push(rule, t("shift.zNumberLater"));
  lines.push("", "");
  return lines;
}
