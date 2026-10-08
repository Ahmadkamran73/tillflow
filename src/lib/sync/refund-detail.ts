import { z } from "zod";
import type { RefundAvailable } from "@/lib/money";

/**
 * A past sale as `ops.device_find_sale` returns it (snake_case from SQL): everything a refund needs
 * and nothing about the customer. Parsed on the server for the sync check and on the till for the
 * lookup screen.
 */
const int = z.number().int();

const detailLine = z.object({
  id: z.uuid(),
  line_no: int,
  kind: z.enum(["item", "deposit"]),
  variant_id: z.uuid().nullable(),
  name: z.string(),
  qty: int,
  unit_price: int,
  serial: z.string().nullable(),
  discount: int,
  tax_category: z.string().nullable(),
  tax_rate_bp: int.nullable(),
  net: int.nullable(),
  vat: int.nullable(),
  gross: int,
  refunded_qty: int,
});

const detailPayment = z.object({
  method: z.enum(["cash", "card", "voucher", "exchange"]),
  type_id: z.uuid().nullable(),
  label: z.string().nullable(),
  amount: int,
  tip: int,
});

export const saleDetail = z.object({
  sale: z.object({
    id: z.uuid(),
    register_id: z.uuid(),
    register_name: z.string().nullable(),
    receipt_seq: int,
    completed_at: z.string(),
    mode: z.enum(["eat_in", "take_away"]),
    items_total: int,
    vat: int,
    non_vat: int,
    cash_rounding: int,
    amount_due: int,
  }),
  lines: z.array(detailLine),
  payments: z.array(detailPayment),
  refunded: z.object({
    cash: int,
    card: int,
    voucher: int,
    /** What earlier refunds are worth (items + deposits): the approval limit counts it. */
    value: int.default(0),
    /** Earlier refunds that paid cash out: each rounded on its own, so each can drift 2c. */
    cash_refunds: int.default(0),
  }),
});
export type SaleDetail = z.infer<typeof saleDetail>;
export type SaleDetailLine = SaleDetail["lines"][number];

export const saleDetails = z.array(saleDetail);

/**
 * What each method can still send back: what it took on the sale less what earlier refunds already
 * sent by it. Cash counts exchange credit that paid for the sale (it is cash-equivalent), and
 * rounding is already inside the payment amounts.
 */
export function availableOf(d: SaleDetail): RefundAvailable {
  const paid = { cash: 0, card: 0, voucher: 0 };
  for (const p of d.payments) paid[p.method === "exchange" ? "voucher" : p.method] += p.amount;
  return {
    cash: Math.max(paid.cash - d.refunded.cash, 0),
    card: Math.max(paid.card - d.refunded.card, 0),
    voucher: Math.max(paid.voucher - d.refunded.voucher, 0),
  };
}
