import type { ReceiptOptions } from "@/config/business-type-presets";
import { t } from "@/lib/i18n";
import { formatCents, lineDiscountOf, localDate, settleTenders } from "@/lib/money";
import {
  lineTotal,
  serviceChargeName,
  serviceLinesOf,
  unitWithModifiers,
  type PricedCart,
} from "./cart";
import type { ReceiptSale } from "./db";
import { BARCODE_MARK } from "./print/escpos";
import { receiptNo } from "./sale";
import { saleCode } from "./sale-code";

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
  /** Cafes: the name the order is called by; device-only. */
  orderName?: string;
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
  /** One per payment: cash shows what was handed over; card what it settled. */
  payments: {
    label: string;
    method: "cash" | "card" | "exchange";
    cents: number;
    /** Card tip, outside the total. */
    tipCents: number;
    /** Terminal receipt reference the cashier typed; never a card number. */
    reference?: string;
  }[];
  changeCents: number;
  footer: string | null;
  /** The sale's code, printed as a barcode so a refund can find the sale by scanning it. */
  code?: string;
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
  // `priced` has no cash rounding; it applies to the cash share of the payments only.
  const settlement = settleTenders(
    basket.total,
    sale.tenders.map((t) => ({ method: t.method, amount: t.amountCents, tip: t.tipCents })),
    { roundCash: sale.roundCash ?? true },
  );
  if (!settlement.ok) throw new RangeError(`payments do not settle the sale: ${settlement.error}`);
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

  const itemLines = sale.cart.lines.map((l, i) => {
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
  // The service charge prints as its own line, one per VAT rate, after the items (the sale stores it
  // per item so refunds can pair it with them; the receipt adds the items of one rate together).
  const serviceByRate = new Map<number, { gross: number; net: number; vat: number }>();
  for (const v of serviceLinesOf(priced)) {
    const r = serviceByRate.get(v.rateBp) ?? { gross: 0, net: 0, vat: 0 };
    r.gross += v.gross;
    r.net += v.net;
    r.vat += v.vat;
    serviceByRate.set(v.rateBp, r);
  }
  const lines = [
    ...itemLines,
    ...[...serviceByRate]
      .sort((x, y) => y[0] - x[0])
      .map(([rateBp, r]) => ({
        name: serviceChargeName(sale.cart.serviceBp ?? 0),
        detail: [] as string[],
        qty: 1,
        unitCents: r.gross,
        totalCents: r.gross,
        discountCents: 0,
        rateBp,
        netCents: r.net,
        vatCents: r.vat,
      })),
  ];
  const deposits = sale.cart.lines.flatMap((l, i) => {
    const d = basket.nonVatLines.find((x) => x.index === priced.itemIndex[i]! + 1);
    return l.depositCents > 0 && d ? [{ name: l.name, cents: d.gross }] : [];
  });

  return {
    kind: isInvoice ? "vat_invoice" : "receipt",
    takeAway: sale.cart.mode === "take_away",
    ...(sale.cart.orderName ? { orderName: sale.cart.orderName } : {}),
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
    roundingCents: settlement.rounding,
    dueCents: settlement.amountDue,
    payments: sale.tenders.map((t) => ({
      label: t.label,
      method: t.method,
      cents: t.amountCents,
      tipCents: t.tipCents,
      ...(t.reference ? { reference: t.reference } : {}),
    })),
    changeCents: settlement.change,
    footer: header.receiptFooter,
    code: saleCode(sale.id),
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
  if (r.orderName) wrap(`${labels.orderName}: ${r.orderName}`);
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
  for (const p of r.payments) {
    row(p.label, formatCents(p.cents));
    if (p.tipCents > 0) row(`  ${labels.tip}`, formatCents(p.tipCents));
    if (p.reference) wrap(`${labels.reference} ${p.reference}`, "  ");
  }
  if (r.changeCents > 0) row(labels.change, formatCents(r.changeCents));
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
  if (r.code) out.push(BARCODE_MARK + r.code);
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
  tip: string;
  reference: string;
  change: string;
  takeAway: string;
  orderName: string;
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
  tip: t("receipt.tip"),
  reference: t("receipt.reference"),
  change: t("receipt.change"),
  takeAway: t("receipt.takeAway"),
  orderName: t("receipt.orderName"),
  discount: t("receipt.discount"),
});
