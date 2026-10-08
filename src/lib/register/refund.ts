import { v7 as uuidv7 } from "uuid";
import { settleTenders, type RefundAvailable } from "@/lib/money";
import { lineTotal, unitWithModifiers, type PricedCart } from "./cart";
import type { LocalRefund, LocalRefundLeg, LocalRefundLine, LocalSale, RegisterDb } from "./db";
import type { Feed } from "./feed";
import { completeSale } from "./sale";
import { saleCode, saleIdOfCode } from "./sale-code";
import { availableOf, saleDetails, type SaleDetail } from "@/lib/sync/refund-detail";
import type { PricedRefundLine } from "@/lib/sync/refund-price";
import type { RefundKind, RefundReasonCode } from "@/lib/sync/refund-protocol";

/** "Till 1 · R000003": refunds have their own series, so a refund never uses a sale's number. */
export const refundReceiptNo = (registerName: string, seq: number) =>
  `${registerName} · R${String(seq).padStart(6, "0")}`;

/**
 * A sale held on this device as a refundable `SaleDetail`, in the same shape the server returns.
 * The lines are worked out with the money library from the sale's inputs and the rates of the day
 * it was sold, in the order the server stores them (an item, then its deposit), so a line's
 * `line_no` here is the same as on the server. Nothing is looked up from today's catalogue.
 */
export function detailOfLocalSale(
  sale: LocalSale,
  priced: PricedCart,
  registerName: string,
): SaleDetail {
  const { basket } = priced;
  const settlement = settleTenders(
    basket.total,
    sale.tenders.map((t) => ({ method: t.method, amount: t.amountCents, tip: t.tipCents })),
    { roundCash: sale.roundCash ?? true },
  );
  if (!settlement.ok) throw new RangeError(`payments do not settle the sale: ${settlement.error}`);

  const lines: SaleDetail["lines"] = [];
  sale.cart.lines.forEach((l, i) => {
    const at = priced.itemIndex[i]!;
    const v = basket.vatLines.find((x) => x.index === at)!;
    const unit = unitWithModifiers(l);
    const gross = lineTotal(priced, at);
    lines.push({
      id: `${sale.id}:${lines.length + 1}`,
      line_no: lines.length + 1,
      kind: "item",
      variant_id: l.variantId,
      name: l.name,
      qty: l.qty,
      unit_price: unit,
      serial: l.serial ?? null,
      discount: unit * l.qty - gross,
      tax_category: v.taxCategory,
      tax_rate_bp: v.rateBp,
      net: v.net,
      vat: v.vat,
      gross,
      refunded_qty: 0,
    });
    const deposit = basket.nonVatLines.find((n) => n.index === at + 1 && n.kind === "deposit");
    if (l.depositCents > 0 && deposit) {
      lines.push({
        id: `${sale.id}:${lines.length + 1}`,
        line_no: lines.length + 1,
        kind: "deposit",
        variant_id: l.variantId,
        name: l.name,
        qty: l.qty,
        unit_price: l.depositCents,
        serial: null,
        discount: 0,
        tax_category: null,
        tax_rate_bp: null,
        net: null,
        vat: null,
        gross: deposit.gross,
        refunded_qty: 0,
      });
    }
  });

  return {
    sale: {
      id: sale.id,
      register_id: sale.registerId,
      register_name: registerName,
      receipt_seq: sale.receiptSeq,
      completed_at: sale.completedAt,
      mode: sale.cart.mode ?? "eat_in",
      items_total: basket.itemsTotal,
      vat: basket.vatTotal,
      non_vat: basket.nonVatTotal,
      cash_rounding: settlement.rounding,
      amount_due: settlement.amountDue,
    },
    lines,
    // Cash settles its share plus rounding (what was handed over less the change).
    payments: sale.tenders.map((t) => ({
      method: t.method,
      type_id: t.typeId,
      label: t.label,
      amount: t.method === "cash" ? settlement.cashShare + settlement.rounding : t.amountCents,
      tip: t.tipCents,
    })),
    refunded: { cash: 0, card: 0, voucher: 0, value: 0, cash_refunds: 0 },
  };
}

/** How much each method has sent back in these refunds (exchange credit is not money out). */
export function refundedByMethod(
  refunds: readonly Pick<LocalRefund, "legs">[],
): Record<"cash" | "card" | "voucher", number> {
  const out = { cash: 0, card: 0, voucher: 0 };
  for (const r of refunds) for (const l of r.legs) out[l.method] += l.amountCents;
  return out;
}

/**
 * The sale with refunds this device knows about taken off: units already returned and money already
 * sent back by each method. Pass only the refunds the sale's own numbers do not already include
 * (all of them for a sale held locally; only the not-yet-synced ones for a sale the server sent).
 */
export function applyLocalRefunds(detail: SaleDetail, refunds: readonly LocalRefund[]): SaleDetail {
  const mine = refunds.filter((r) => r.originalSaleId === detail.sale.id);
  if (mine.length === 0) return detail;
  const back = refundedByMethod(mine);
  return {
    ...detail,
    lines: detail.lines.map((l) => ({
      ...l,
      refunded_qty:
        l.refunded_qty +
        mine
          .flatMap((r) => r.lines)
          .reduce((n, rl) => (rl.lineNo === l.line_no ? n + rl.qty : n), 0),
    })),
    refunded: {
      cash: detail.refunded.cash + back.cash,
      card: detail.refunded.card + back.card,
      voucher: detail.refunded.voucher + back.voucher,
      value:
        detail.refunded.value +
        mine.reduce((n, r) => n + r.lines.reduce((m, l) => m + l.grossCents, 0), 0),
      cash_refunds:
        detail.refunded.cash_refunds + mine.filter((r) => r.legs.some((l) => l.method === "cash")).length,
    },
  };
}

/** Anything the shop can still give back on this sale: units left and money by method. */
export function refundable(detail: SaleDetail): { unitsLeft: number; available: RefundAvailable } {
  return {
    unitsLeft: detail.lines.reduce(
      (n, l) => n + (l.kind === "item" ? l.qty - l.refunded_qty : 0),
      0,
    ),
    available: availableOf(detail),
  };
}

// ---------------------------------------------------------------- finding a sale on this device

/** Sales this device holds that the server also holds or will hold (a rejected sale is not on it). */
const refundableSales = (db: RegisterDb) =>
  db.sales.filter((s) => s.syncState !== "rejected").sortBy("completedAt");

/** The newest sales rung up on this device, for picking from a list. */
export async function recentLocalSales(db: RegisterDb, limit = 12): Promise<LocalSale[]> {
  return (await refundableSales(db)).reverse().slice(0, limit);
}

export async function findLocalSale(
  db: RegisterDb,
  query:
    | { by: "id"; id: string }
    | { by: "receipt"; registerId: string; seq: number }
    | { by: "serial"; serial: string },
): Promise<LocalSale[]> {
  const all = await refundableSales(db);
  const hits =
    query.by === "id"
      ? all.filter((s) => s.id === query.id)
      : query.by === "receipt"
        ? all.filter((s) => s.registerId === query.registerId && s.receiptSeq === query.seq)
        : all.filter((s) =>
            s.cart.lines.some((l) => l.serial?.toLowerCase() === query.serial.trim().toLowerCase()),
          );
  return hits.sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, 5);
}

/** Refunds still in the outbox (the server has not counted them yet), plus rejected ones are ignored. */
export const pendingRefunds = (db: RegisterDb) =>
  db.refunds.where("syncState").equals("pending").toArray();

export const refundsOfSale = (db: RegisterDb, saleId: string) =>
  db.refunds
    .where("originalSaleId")
    .equals(saleId)
    .filter((r) => r.syncState !== "rejected")
    .toArray();

export type ServerLookup =
  | { by: "id"; id: string }
  | { by: "receipt"; registerId: string; seq: number }
  | { by: "serial"; serial: string };

/**
 * Asks the server for sales of this shop (another till's, an older one, or by serial). Needs a
 * connection: "offline" means the cashier can still refund this till's own recent sales.
 */
export async function lookupOnServer(
  orgId: string,
  query: ServerLookup,
  /** The person serving: a cashier finds this till's sales and their own, a manager any. */
  viewerId: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: "ok"; sales: SaleDetail[] } | { status: "offline" | "unpaired" | "failed" }> {
  const params = new URLSearchParams({ orgId, by: query.by, as: viewerId });
  if (query.by === "id") params.set("id", query.id);
  else if (query.by === "receipt") {
    params.set("register_id", query.registerId);
    params.set("seq", String(query.seq));
  } else params.set("serial", query.serial.trim());
  let res: Response;
  try {
    res = await fetchFn(`/api/v1/register/sales/lookup?${params}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    return { status: "offline" };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) return { status: "unpaired" };
  if (!res.ok) return { status: "failed" };
  try {
    const body = (await res.json()) as { sales?: unknown };
    return { status: "ok", sales: saleDetails.parse(body.sales) };
  } catch {
    return { status: "failed" };
  }
}

// ---------------------------------------------------------------- writing a refund

export type RefundInput = {
  /** Made in advance for an exchange (its sale names it); otherwise a fresh UUIDv7. */
  id?: string;
  /** The moment the manager approved / the exchange began; otherwise now. */
  completedAt?: string;
  registerId: string;
  cashierUserId: string;
  approvalId?: string;
  claimedApprover?: string;
  originalSaleId: string;
  originalReceiptNo: string;
  kind: RefundKind;
  reasonCode: RefundReasonCode;
  reasonNote?: string;
  lines: PricedRefundLine[];
  legs: LocalRefundLeg[];
  creditCents?: number;
  exchangeSaleId?: string;
  roundCash: boolean;
  roundingCents: number;
  expectedAmountCents: number;
};

const toLocalLine = (l: PricedRefundLine): LocalRefundLine => ({
  lineNo: l.lineNo,
  qty: l.qty,
  restock: l.restock,
  kind: l.kind,
  name: l.name,
  serial: l.serial,
  rateBp: l.rateBp,
  grossCents: l.gross,
  vatCents: l.vat,
  netCents: l.net,
});

/**
 * Saves a refund in the outbox (state `pending`) and gives it the next refund number for its till,
 * in one transaction so numbers are sequential and gap-free per till on this device. Like a sale,
 * nothing here touches the network; the original sale is never edited.
 */
export async function completeRefund(db: RegisterDb, input: RefundInput): Promise<LocalRefund> {
  return db.transaction("rw", db.meta, db.refunds, async () => {
    const key = `refundSeq:${input.registerId}`;
    const local = ((await db.meta.get(key))?.value as number | undefined) ?? 0;
    const registers = (await db.meta.get("registers"))?.value as Feed["registers"] | undefined;
    const known = registers?.find((r) => r.id === input.registerId)?.lastRefundSeq ?? 0;
    const seq = Math.max(local, known) + 1;
    const refund: LocalRefund = {
      id: input.id ?? uuidv7(),
      registerId: input.registerId,
      cashierUserId: input.cashierUserId,
      approvalId: input.approvalId,
      claimedApprover: input.approvalId ? undefined : input.claimedApprover,
      originalSaleId: input.originalSaleId,
      originalReceiptNo: input.originalReceiptNo,
      kind: input.kind,
      reasonCode: input.reasonCode,
      reasonNote: input.reasonNote,
      receiptSeq: seq,
      completedAt: input.completedAt ?? new Date().toISOString(),
      lines: input.lines.map(toLocalLine),
      legs: input.legs,
      creditCents: input.creditCents ?? 0,
      exchangeSaleId: input.exchangeSaleId,
      roundCash: input.roundCash,
      roundingCents: input.roundingCents,
      expectedAmountCents: input.expectedAmountCents,
      syncState: "pending",
      attempts: 0,
    };
    await db.meta.put({ key, value: seq });
    await db.refunds.add(refund);
    return refund;
  });
}


/**
 * Saves an exchange: the refund of the returned goods and the sale that spends its credit, in ONE
 * transaction. Either both exist or neither does, so an exchange is never half done on the device.
 */
export async function completeExchange(
  db: RegisterDb,
  args: { refund: RefundInput; sale: Parameters<typeof completeSale>[1] },
): Promise<{ refund: LocalRefund; sale: LocalSale }> {
  return db.transaction("rw", db.meta, db.sales, db.refunds, async () => {
    const refund = await completeRefund(db, args.refund);
    const sale = await completeSale(db, args.sale);
    return { refund, sale };
  });
}

export { saleCode, saleIdOfCode };
