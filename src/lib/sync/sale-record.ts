import { lineDiscountOf, type Settlement } from "@/lib/money";
import { unitWithModifiers, type Cart, type PricedCart } from "@/lib/register/cart";
import type { ReviewFlag } from "./process";
import type { SyncSale } from "./protocol";

/**
 * Turns a priced sale into the JSON that `ops.record_sale` stores. No maths of its own: every
 * amount comes from the money library's basket (`vatLines`, `nonVatLines`, totals). The VAT rate
 * and amounts are copied onto each line, so a completed sale is never re-priced (refunds use them).
 */
export function buildSaleRecord(args: {
  orgId: string;
  registerId: string;
  /** The cashier who rang the sale up (their PIN unlocked the till). */
  userId: string;
  /** Trusted callers only: the manager who approved it from the back office (no till supplies this). */
  approverUserId?: string;
  /** A till's proof of a manager PIN (register_approvals.id); the database derives the approver. */
  approvalId?: string;
  sale: SyncSale;
  cart: Cart;
  priced: PricedCart;
  /** The payments checked against the priced total (`settleTenders`); must be ok. */
  settlement: Settlement;
  pricedAsOf: Date;
  /** Saved but worth a manager's look (see process.ts). */
  reviewFlags?: ReviewFlag[];
}) {
  const { sale, cart, priced, settlement } = args;
  if (!settlement.ok) throw new RangeError(`payments do not settle the sale: ${settlement.error}`);
  const { basket } = priced;
  const lines: Record<string, unknown>[] = [];

  cart.lines.forEach((l, i) => {
    const at = priced.itemIndex[i]!;
    const taxed = basket.vatLines.filter((v) => v.index === at);
    const gross = taxed.reduce((s, v) => s + v.gross, 0);
    const first = taxed[0];
    if (!first || taxed.length !== 1) throw new Error("item line must have exactly one VAT line");
    const unit = unitWithModifiers(l);
    lines.push({
      kind: "item",
      variant_id: l.variantId,
      product_id: l.productId,
      name: l.name,
      qty: l.qty,
      unit_price_cents: unit,
      modifiers: l.modifiers,
      serial: l.serial ?? null,
      discount_cents: lineDiscountOf(unit, l.qty, gross),
      tax_category: first.taxCategory,
      tax_rate_bp: first.rateBp,
      net_cents: first.net,
      vat_cents: first.vat,
      gross_cents: gross,
    });
    const deposit = basket.nonVatLines.find((n) => n.index === at + 1 && n.kind === "deposit");
    if (l.depositCents > 0 && deposit) {
      lines.push({
        kind: "deposit",
        variant_id: l.variantId,
        product_id: l.productId,
        name: l.name,
        qty: l.qty,
        unit_price_cents: l.depositCents,
        gross_cents: deposit.gross,
      });
    }
  });

  return {
    sale: {
      id: sale.id,
      org_id: args.orgId,
      register_id: args.registerId,
      user_id: args.userId,
      approved_by: args.approverUserId ?? null,
      approval_id: args.approvalId ?? null,
      receipt_seq: sale.receiptSeq,
      mode: sale.mode,
      completed_at: sale.completedAt,
      priced_as_of: args.pricedAsOf.toISOString(),
      items_total: basket.itemsTotal,
      vat: basket.vatTotal,
      non_vat: basket.nonVatTotal,
      cash_rounding: settlement.rounding,
      amount_due: settlement.amountDue,
      client_due: sale.expectedDueCents,
      client_vat: sale.expectedVatCents ?? null,
      review_flags: args.reviewFlags ?? [],
    },
    lines,
    // Cash settles its share plus rounding (the rest of what was handed over is change); card and
    // settles exactly its amount. Tips ride on the card payment, outside the sale total.
    payments: sale.tenders.map((t) =>
      t.method === "cash"
        ? {
            type_id: t.typeId,
            method: t.method,
            amount: settlement.cashShare + settlement.rounding,
            tendered: t.amountCents,
            change: settlement.change,
          }
        : {
            type_id: t.typeId,
            method: t.method,
            amount: t.amountCents,
            tendered: t.amountCents,
            change: 0,
            tip: t.tipCents,
            reference: t.reference ?? null,
            // Exchange credit names the refund whose returned goods paid for it.
            ...(t.refundId ? { refund_id: t.refundId } : {}),
          },
    ),
  };
}
