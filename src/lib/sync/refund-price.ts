import { refundLine, refundTotals, type RefundTotals } from "@/lib/money";
import type { SaleDetail } from "./refund-detail";

/**
 * The money of a refund, worked out from the ORIGINAL sale's stored lines (never re-priced): each
 * line gives back its share at its own original rate. Shared by the till (to show the amounts) and
 * the server (to recompute them); `ops.record_refund` repeats the same rule in SQL.
 */
export type RefundPick = { lineNo: number; qty: number; restock: boolean };

export type PricedRefundLine = {
  lineNo: number;
  /** The row id of the sale line (a synthetic id for a sale held only on the device). */
  saleLineId: string;
  qty: number;
  restock: boolean;
  kind: "item" | "deposit";
  name: string;
  serial: string | null;
  /** The original line's rate, copied; null for a deposit (outside VAT). */
  rateBp: number | null;
  gross: number;
  vat: number;
  net: number;
};

export type RefundPriceError =
  { error: "unknown_line"; lineNo: number } | { error: "too_many"; lineNo: number; left: number };

export function priceRefundLines(
  detail: SaleDetail,
  picks: readonly RefundPick[],
):
  | { ok: true; lines: PricedRefundLine[]; totals: RefundTotals }
  | ({ ok: false } & RefundPriceError) {
  const byNo = new Map(detail.lines.map((l) => [l.line_no, l]));
  const lines: PricedRefundLine[] = [];
  for (const pick of picks) {
    const line = byNo.get(pick.lineNo);
    if (!line) return { ok: false, error: "unknown_line", lineNo: pick.lineNo };
    const left = line.qty - line.refunded_qty;
    if (pick.qty < 1 || pick.qty > left) {
      return { ok: false, error: "too_many", lineNo: line.line_no, left };
    }
    const part = refundLine({
      qty: line.qty,
      gross: line.gross,
      vat: line.kind === "item" ? (line.vat ?? 0) : 0,
      refundedQty: line.refunded_qty,
      refundQty: pick.qty,
    });
    lines.push({
      lineNo: line.line_no,
      saleLineId: line.id,
      qty: pick.qty,
      restock: pick.restock,
      kind: line.kind,
      name: line.name,
      serial: line.serial,
      rateBp: line.tax_rate_bp,
      gross: part.gross,
      vat: part.vat,
      net: part.net,
    });
  }
  const totals = refundTotals(
    lines
      .filter((l) => l.kind === "item")
      .map((l) => ({ rateBp: l.rateBp ?? 0, gross: l.gross, vat: l.vat })),
    lines.filter((l) => l.kind === "deposit").map((l) => l.gross),
  );
  return { ok: true, lines, totals };
}
