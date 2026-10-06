import type { ReceiptOptions } from "@/config/business-type-presets";
import { t } from "@/lib/i18n";
import { changeDue, formatCents, lineDiscountOf, localDate } from "@/lib/money";
import { lineTotal, unitWithModifiers, type PricedCart } from "./cart";
import type { ReceiptSale } from "./db";
import { receiptNo } from "./sale";

export type ReceiptHeader = {
  name: string;
  legalName: string | null;
  vatNumber: string | null;
  address: string | null;
  eircode: string | null;
  receiptFooter: string | null;
  timezone: string;
};

export type Receipt = {
  kind: "receipt" | "vat_invoice";
  takeAway: boolean;
  number: string;
  /** Shop-local, e.g. "05/10/2026 14:32". */
  dateTime: string;
  business: { name: string; vatNumber: string | null; address: string[] };
  lines: {
    name: string;
    detail: string[];
    qty: number;
    unitCents: number;
    totalCents: number;
    /** Line and basket discount taken off this line; 0 when none. */
    discountCents: number;
    rateBp: number;
    netCents: number;
    vatCents: number;
    /** "DD/MM/YYYY", electronics only. */
    warrantyEnds?: string;
  }[];
  deposits: { name: string; cents: number }[];
  vat: { rateBp: number; netCents: number; vatCents: number; grossCents: number }[];
  totalCents: number;
  roundingCents: number;
  dueCents: number;
  tenderedCents: number;
  changeCents: number;
  footer: string | null;
  customer?: { name: string; address: string; vatNumber: string };
};

/** Adds whole months to a `YYYY-MM-DD` date, clamping to the month end (31 Jan + 1 → 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const idx = y * 12 + (m - 1) + months;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ny}-${p(nm)}-${p(Math.min(d, last))}`;
}

const ddmmyyyy = (iso: string) => iso.split("-").reverse().join("/");

/**
 * Everything printed on a receipt or VAT invoice. All amounts are taken from the money library's
 * basket (`priced`); nothing is recalculated here.
 */
export function buildReceipt(args: {
  sale: ReceiptSale;
  priced: PricedCart;
  registerName: string;
  header: ReceiptHeader;
  options: ReceiptOptions;
  asInvoice?: boolean;
}): Receipt {
  const { sale, priced, header, options } = args;
  const { basket } = priced;
  const when = new Date(sale.completedAt);
  const fmt = new Intl.DateTimeFormat("en-IE", {
    timeZone: header.timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const saleDay = localDate(when, header.timezone);
  const isInvoice = !!args.asInvoice && !!sale.invoice;

  const lines = sale.cart.lines.map((l, i) => {
    const at = priced.itemIndex[i]!;
    const v = basket.vatLines.find((x) => x.index === at)!;
    return {
      name: l.name,
      detail: [...l.modifiers.map((m) => m.name), ...(l.serial ? [`S/N ${l.serial}`] : [])],
      qty: l.qty,
      unitCents: unitWithModifiers(l),
      totalCents: lineTotal(priced, at),
      discountCents: lineDiscountOf(unitWithModifiers(l), l.qty, lineTotal(priced, at)),
      rateBp: v.rateBp,
      netCents: v.net,
      vatCents: v.vat,
      ...(options.warrantyEndDate && l.warrantyMonths
        ? { warrantyEnds: ddmmyyyy(addMonths(saleDay, l.warrantyMonths)) }
        : {}),
    };
  });
  const deposits = sale.cart.lines.flatMap((l, i) => {
    const d = basket.nonVatLines.find((x) => x.index === priced.itemIndex[i]! + 1);
    return l.depositCents > 0 && d ? [{ name: l.name, cents: d.gross }] : [];
  });

  return {
    kind: isInvoice ? "vat_invoice" : "receipt",
    takeAway: sale.cart.mode === "take_away",
    number: receiptNo(args.registerName, sale.receiptSeq),
    dateTime: fmt.format(when).replace(",", ""),
    business: {
      name: header.legalName || header.name,
      vatNumber: header.vatNumber,
      address: [header.address, header.eircode].filter((s): s is string => !!s),
    },
    lines,
    deposits,
    vat: basket.vatByRate.map((r) => ({
      rateBp: r.rateBp,
      netCents: r.net,
      vatCents: r.vat,
      grossCents: r.gross,
    })),
    totalCents: basket.total,
    roundingCents: basket.cashRounding,
    dueCents: basket.amountDue,
    tenderedCents: sale.tenderedCents,
    changeCents: changeDue(sale.tenderedCents, basket.amountDue),
    footer: header.receiptFooter,
    ...(isInvoice ? { customer: sale.invoice } : {}),
  };
}

const pct = (bp: number) => `${bp / 100}%`; // display only

/** Plain-text receipt, one string per printed line, none longer than `cols`. */
export function receiptText(r: Receipt, cols: 32 | 42 | 48, labels: ReceiptLabels): string[] {
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
  if (r.business.vatNumber) centre(`${labels.vatNo} ${r.business.vatNumber}`);
  rule();
  if (r.kind === "vat_invoice") out.push(labels.vatInvoice.toUpperCase());
  out.push(`${labels.receiptNo} ${r.number}`);
  out.push(r.dateTime);
  if (r.takeAway) out.push(labels.takeAway);
  if (r.customer) {
    rule();
    wrap(r.customer.name);
    wrap(r.customer.address);
    out.push(`${labels.customerVat} ${r.customer.vatNumber}`);
  }
  rule();
  for (const l of r.lines) {
    row(l.qty > 1 ? `${l.qty} x ${l.name}` : l.name, formatCents(l.totalCents));
    if (l.qty > 1) wrap(`@ ${formatCents(l.unitCents)}`, "  ");
    l.detail.forEach((d) => wrap(d, "  "));
    if (l.discountCents > 0) wrap(`${labels.discount} -${formatCents(l.discountCents)}`, "  ");
    if (r.kind === "vat_invoice")
      wrap(
        `${labels.net} ${formatCents(l.netCents)} ${labels.vat} ${pct(l.rateBp)} ${formatCents(l.vatCents)}`,
        "  ",
      );
    if (l.warrantyEnds) wrap(`${labels.warrantyUntil} ${l.warrantyEnds}`, "  ");
  }
  r.deposits.forEach((d) => row(labels.deposit, formatCents(d.cents)));
  rule();
  if (r.roundingCents !== 0) {
    row(labels.subtotal, formatCents(r.totalCents));
    row(labels.rounding, formatCents(r.roundingCents));
  }
  row(labels.total.toUpperCase(), formatCents(r.dueCents));
  row(labels.cash, formatCents(r.tenderedCents));
  row(labels.change, formatCents(r.changeCents));
  rule();
  for (const v of r.vat)
    row(
      `${labels.vat} ${pct(v.rateBp)} (${labels.net} ${formatCents(v.netCents)})`,
      formatCents(v.vatCents),
    );
  if (r.footer) {
    rule();
    r.footer.split("\n").forEach((f) => wrap(f));
  }
  return out;
}

export type ReceiptLabels = {
  vatNo: string;
  vatInvoice: string;
  receiptNo: string;
  customerVat: string;
  net: string;
  vat: string;
  warrantyUntil: string;
  deposit: string;
  subtotal: string;
  rounding: string;
  total: string;
  cash: string;
  change: string;
  takeAway: string;
  discount: string;
};

export const receiptLabels = (): ReceiptLabels => ({
  vatNo: t("receipt.vatNo"),
  vatInvoice: t("receipt.vatInvoice"),
  receiptNo: t("receipt.receiptNo"),
  customerVat: t("receipt.customerVat"),
  net: t("receipt.net"),
  vat: t("receipt.vat"),
  warrantyUntil: t("receipt.warrantyUntil"),
  deposit: t("receipt.deposit"),
  subtotal: t("receipt.subtotal"),
  rounding: t("receipt.rounding"),
  total: t("receipt.total"),
  cash: t("receipt.cash"),
  change: t("receipt.change"),
  takeAway: t("receipt.takeAway"),
  discount: t("receipt.discount"),
});
