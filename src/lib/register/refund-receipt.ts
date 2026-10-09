import { t } from "@/lib/i18n";
import { formatCents, refundTotals } from "@/lib/money";
import type { LocalRefund } from "./db";
import type { ReceiptHeader } from "./receipt";
import { refundReceiptNo } from "./refund";

export type RefundReceipt = {
  kind: LocalRefund["kind"];
  number: string;
  originalNumber: string;
  /** Shop-local, e.g. "05/10/2026 14:32". */
  dateTime: string;
  business: { name: string; vatNumber: string | null; address: string[] };
  reason: string;
  lines: {
    name: string;
    detail: string[];
    qty: number;
    totalCents: number;
    rateBp: number | null;
    netCents: number;
    vatCents: number;
  }[];
  deposits: { name: string; cents: number }[];
  /** VAT reversed at the ORIGINAL line rates. */
  vat: { rateBp: number; netCents: number; vatCents: number; grossCents: number }[];
  totalCents: number;
  creditCents: number;
  roundingCents: number;
  /** What leaves the shop. */
  payoutCents: number;
  legs: {
    label: string;
    method: "cash" | "card";
    cents: number;
    tipCents: number;
    reference?: string;
  }[];
  footer: string | null;
};

/**
 * Everything printed on a refund, void or exchange-return receipt. The amounts are the ones stored
 * on the refund when it was made (worked out from the original sale's lines by the money library);
 * nothing is recalculated here, and no rate is looked up.
 */
export function buildRefundReceipt(args: {
  refund: LocalRefund;
  registerName: string;
  header: ReceiptHeader;
}): RefundReceipt {
  const { refund, header } = args;
  const fmt = new Intl.DateTimeFormat("en-IE", {
    timeZone: header.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const items = refund.lines.filter((l) => l.kind === "item");
  const totals = refundTotals(
    items.map((l) => ({ rateBp: l.rateBp ?? 0, gross: l.grossCents, vat: l.vatCents })),
    refund.lines.filter((l) => l.kind === "deposit").map((l) => l.grossCents),
  );
  const reason = t(`refund.reason.${refund.reasonCode}`);
  return {
    kind: refund.kind,
    number: refundReceiptNo(args.registerName, refund.receiptSeq),
    originalNumber: refund.originalReceiptNo,
    dateTime: fmt.format(new Date(refund.completedAt)).replace(",", ""),
    business: {
      name: header.legalName || header.name,
      vatNumber: header.vatNumber,
      address: [header.address, header.eircode].filter((s): s is string => !!s),
    },
    reason: refund.reasonNote ? `${reason}: ${refund.reasonNote}` : reason,
    lines: items.map((l) => ({
      name: l.name,
      detail: l.serial ? [`S/N ${l.serial}`] : [],
      qty: l.qty,
      totalCents: l.grossCents,
      rateBp: l.rateBp,
      netCents: l.netCents,
      vatCents: l.vatCents,
    })),
    deposits: refund.lines
      .filter((l) => l.kind === "deposit")
      .map((l) => ({ name: l.name, cents: l.grossCents })),
    vat: totals.vatByRate.map((r) => ({
      rateBp: r.rateBp,
      netCents: r.net,
      vatCents: r.vat,
      grossCents: r.gross,
    })),
    totalCents: totals.total,
    creditCents: refund.creditCents,
    roundingCents: refund.roundingCents,
    payoutCents: totals.total - refund.creditCents + refund.roundingCents,
    legs: refund.legs.map((l) => ({
      label: l.label,
      method: l.method,
      cents: l.amountCents,
      tipCents: l.tipCents,
      ...(l.reference ? { reference: l.reference } : {}),
    })),
    footer: header.receiptFooter,
  };
}

const pct = (bp: number) => `${bp / 100}%`; // display only

/** Plain-text refund receipt, one string per printed line, none longer than `cols`. */
export function refundReceiptText(r: RefundReceipt, cols: 32 | 42 | 48): string[] {
  const out: string[] = [];
  const wrap = (s: string, indent = "") => {
    const words = s.split(/\s+/);
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : indent + w;
      if (next.length > cols && cur) {
        out.push(cur);
        cur = indent + w;
      } else cur = next;
      while (cur.length > cols) {
        out.push(cur.slice(0, cols));
        cur = indent + cur.slice(cols);
      }
    }
    if (cur) out.push(cur);
  };
  const row = (left: string, right: string) => {
    const room = cols - right.length - 1;
    out.push(`${left.length > room ? left.slice(0, room) : left.padEnd(room)} ${right}`);
  };
  const rule = () => out.push("-".repeat(cols));
  const centre = (s: string) =>
    out.push(s.length >= cols ? s.slice(0, cols) : s.padStart((cols + s.length) >> 1));

  centre(r.business.name);
  r.business.address.forEach((a) => centre(a));
  if (r.business.vatNumber) centre(`${t("receipt.vatNo")} ${r.business.vatNumber}`);
  rule();
  out.push(t(`refundReceipt.${r.kind}`).toUpperCase());
  out.push(`${t("refundReceipt.number")} ${r.number}`);
  out.push(`${t("refundReceipt.original")} ${r.originalNumber}`);
  out.push(r.dateTime);
  wrap(`${t("refundReceipt.reason")}: ${r.reason}`);
  rule();
  out.push(t("refundReceipt.returned"));
  for (const l of r.lines) {
    row(l.qty > 1 ? `${l.qty} x ${l.name}` : l.name, `-${formatCents(l.totalCents)}`);
    l.detail.forEach((d) => wrap(d, "  "));
  }
  r.deposits.forEach((d) => row(t("refundReceipt.deposit"), `-${formatCents(d.cents)}`));
  rule();
  row(t("refundReceipt.total").toUpperCase(), `-${formatCents(r.totalCents)}`);
  if (r.creditCents > 0) row(t("refundReceipt.credit"), formatCents(r.creditCents));
  if (r.roundingCents !== 0) row(t("refundReceipt.rounding"), formatCents(r.roundingCents));
  if (r.legs.length > 0) {
    out.push(t("refundReceipt.refundedTo"));
    for (const l of r.legs) {
      row(`  ${l.label}`, formatCents(l.cents));
      if (l.tipCents > 0) row(`    ${t("refundReceipt.tip")}`, formatCents(l.tipCents));
      if (l.reference) wrap(`${t("receipt.reference")} ${l.reference}`, "    ");
    }
  }
  rule();
  // VAT reversed at the original rates: the same rates the sale was rung up at.
  for (const v of r.vat) {
    row(
      `${t("receipt.vat")} ${pct(v.rateBp)} (${t("receipt.net")} ${formatCents(v.netCents)})`,
      `-${formatCents(v.vatCents)}`,
    );
  }
  if (r.footer) {
    rule();
    r.footer.split("\n").forEach((f) => wrap(f));
  }
  return out;
}
