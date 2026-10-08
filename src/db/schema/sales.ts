import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { products, variants } from "./products";
import { locations, organisations, registers } from "./tenancy";
import { tenderTypes } from "./tenders";

const orgCol = () =>
  uuid("org_id")
    .notNull()
    .references(() => organisations.id);
const createdAtCol = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const saleModes = ["eat_in", "take_away"] as const;

/**
 * A completed sale, written only by `ops.record_sale` after the server re-priced it. Append-only:
 * a trigger refuses UPDATE and DELETE. `id` is the device's UUIDv7 and doubles as the idempotency key.
 */
export const sales = pgTable(
  "sales",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    registerId: uuid("register_id").notNull(),
    locationId: uuid("location_id").notNull(),
    receiptSeq: integer("receipt_seq").notNull(),
    mode: text("mode").notNull().default("eat_in"),
    /** The device's clock: kept for audit, bounded against `receivedAt` on the way in. */
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** The catalogue moment the sale was priced at (its own completion time or the till's pull). */
    pricedAsOf: timestamp("priced_as_of", { withTimezone: true }).notNull(),
    cashierUserId: uuid("cashier_user_id").notNull(),
    itemsTotalCents: integer("items_total_cents").notNull(),
    vatCents: integer("vat_cents").notNull(),
    nonVatCents: integer("non_vat_cents").notNull(),
    cashRoundingCents: integer("cash_rounding_cents").notNull(),
    amountDueCents: integer("amount_due_cents").notNull(),
    /** What the till showed; within 1c of `amountDueCents` or the sale is rejected. */
    clientDueCents: integer("client_due_cents").notNull(),
    /** The VAT the till printed (newer tills only); compared with `vatCents`, never trusted. */
    clientVatCents: integer("client_vat_cents"),
    /** Saved but worth a manager's look: vat_differs, old_prices, rounding_differs. Set at insert only. */
    reviewFlags: text("review_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAtCol(),
  },
  (t) => [
    unique("sales_org_id_id_key").on(t.orgId, t.id),
    unique("sales_org_register_seq_key").on(t.orgId, t.registerId, t.receiptSeq),
    foreignKey({
      name: "sales_org_register_fk",
      columns: [t.orgId, t.registerId],
      foreignColumns: [registers.orgId, registers.id],
    }),
    foreignKey({
      name: "sales_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    index("sales_org_completed_idx").on(t.orgId, t.completedAt),
    index("sales_org_created_idx").on(t.orgId, t.createdAt),
    check("sales_mode", sql`${t.mode} in ('eat_in', 'take_away')`),
    check("sales_receipt_seq", sql`${t.receiptSeq} between 1 and 99999999`),
    check("sales_due_close", sql`abs(${t.amountDueCents} - ${t.clientDueCents}) <= 1`),
    check(
      "sales_review_flags",
      sql`${t.reviewFlags} <@ array['vat_differs', 'old_prices', 'rounding_differs']::text[]`,
    ),
  ],
);

/** One taxed line (or deposit line) of a sale, with its VAT rate snapshotted. Append-only. */
export const saleLines = pgTable(
  "sale_lines",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    saleId: uuid("sale_id").notNull(),
    lineNo: integer("line_no").notNull(),
    /** item = a taxed line; deposit = Re-turn deposit, outside VAT. */
    kind: text("kind").notNull().default("item"),
    variantId: uuid("variant_id"),
    productId: uuid("product_id"),
    name: text("name").notNull(),
    qty: integer("qty").notNull(),
    /** VAT-inclusive, with modifiers. */
    unitPriceCents: integer("unit_price_cents").notNull(),
    modifiers: jsonb("modifiers")
      .notNull()
      .default(sql`'[]'::jsonb`),
    serial: text("serial"),
    discountCents: integer("discount_cents").notNull().default(0),
    taxCategory: text("tax_category"),
    taxRateBp: integer("tax_rate_bp"),
    netCents: integer("net_cents"),
    vatCents: integer("vat_cents"),
    grossCents: integer("gross_cents").notNull(),
    createdAt: createdAtCol(),
  },
  (t) => [
    unique("sale_lines_org_id_id_key").on(t.orgId, t.id),
    unique("sale_lines_sale_line_key").on(t.saleId, t.lineNo),
    foreignKey({
      name: "sale_lines_org_sale_fk",
      columns: [t.orgId, t.saleId],
      foreignColumns: [sales.orgId, sales.id],
    }),
    foreignKey({
      name: "sale_lines_org_variant_fk",
      columns: [t.orgId, t.variantId],
      foreignColumns: [variants.orgId, variants.id],
    }),
    index("sale_lines_org_sale_idx").on(t.orgId, t.saleId),
    index("sale_lines_org_variant_idx").on(t.orgId, t.variantId),
    check("sale_lines_kind", sql`${t.kind} in ('item', 'deposit')`),
    check("sale_lines_qty", sql`${t.qty} between 1 and 999`),
    check(
      "sale_lines_snapshot",
      sql`(${t.kind} = 'item' and ${t.taxRateBp} is not null and ${t.netCents} is not null and ${t.vatCents} is not null and ${t.taxCategory} is not null)
        or (${t.kind} = 'deposit' and ${t.taxRateBp} is null)`,
    ),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    saleId: uuid("sale_id").notNull(),
    /** The location tender type used; null on payments recorded before tender types existed. */
    tenderTypeId: uuid("tender_type_id"),
    /** The type's label when the sale was made (a later rename does not change old receipts). */
    label: text("label"),
    method: text("method").notNull(),
    amountCents: integer("amount_cents").notNull(),
    tenderedCents: integer("tendered_cents").notNull(),
    changeCents: integer("change_cents").notNull(),
    tipCents: integer("tip_cents").notNull().default(0),
    /** Terminal receipt reference for a card tender, or a voucher number; never a card number. */
    providerRef: text("provider_ref"),
    /** For an exchange-credit payment: the exchange refund whose returned goods paid for this sale. */
    exchangeRefundId: uuid("exchange_refund_id"),
    createdAt: createdAtCol(),
  },
  (t) => [
    foreignKey({
      name: "payments_org_exchange_refund_fk",
      columns: [t.orgId, t.exchangeRefundId],
      foreignColumns: [refunds.orgId, refunds.id],
    }),
    foreignKey({
      name: "payments_org_sale_fk",
      columns: [t.orgId, t.saleId],
      foreignColumns: [sales.orgId, sales.id],
    }),
    foreignKey({
      name: "payments_org_tender_type_fk",
      columns: [t.orgId, t.tenderTypeId],
      foreignColumns: [tenderTypes.orgId, tenderTypes.id],
    }),
    index("payments_org_sale_idx").on(t.orgId, t.saleId),
    index("payments_org_created_idx").on(t.orgId, t.createdAt),
    check("payments_method", sql`${t.method} in ('cash', 'card', 'voucher', 'exchange')`),
    // A cash remainder of 1-2c rounds to a zero amount, so zero is allowed; never negative.
    check("payments_amount", sql`${t.amountCents} >= 0`),
    check("payments_change_cash_only", sql`${t.method} = 'cash' or ${t.changeCents} = 0`),
    check(
      "payments_tip",
      sql`${t.tipCents} = 0 or (${t.method} = 'card' and ${t.tipCents} <= ${t.amountCents})`,
    ),
    // Never a card number: at most 40 characters of letters, digits, space, - and /, and fewer than
    // 13 digits in all. Keep in step with `looksLikeCardNumber` in src/lib/register/tender-input.ts.
    check(
      "payments_provider_ref",
      sql`${t.providerRef} is null or (char_length(${t.providerRef}) <= 40 and ${t.providerRef} ~ '^[A-Za-z0-9 /-]*$' and char_length(regexp_replace(${t.providerRef}, '[^0-9]', '', 'g')) < 13)`,
    ),
  ],
);

export const refundKinds = ["refund", "void", "exchange"] as const;
export const refundReasons = [
  "changed_mind",
  "faulty",
  "wrong_item",
  "damaged",
  "void_mistake",
  "other",
] as const;

/**
 * A refund, void or exchange return against an earlier sale, written only by `ops.record_refund`.
 * Append-only like sales: the original sale is never touched. Amounts are positive magnitudes (the
 * money going back); `id` is the device's UUIDv7 and doubles as the idempotency key.
 */
export const refunds = pgTable(
  "refunds",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    registerId: uuid("register_id").notNull(),
    locationId: uuid("location_id").notNull(),
    originalSaleId: uuid("original_sale_id").notNull(),
    kind: text("kind").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonNote: text("reason_note"),
    /** Refund series per till, printed `Till 1 · R000003`. */
    receiptSeq: integer("receipt_seq").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    cashierUserId: uuid("cashier_user_id").notNull(),
    approvedBy: uuid("approved_by"),
    approvalId: uuid("approval_id"),
    /**
     * How the manager approval was settled. 'not_needed': a cashier under the shop's limit.
     * 'verified': a single-use approval the server issued for a PIN it checked. 'self': a manager
     * or owner rang it (the till's word for who was serving). 'unverified': a manager the till
     * named, because it was offline when the PIN was typed. The last two are shown to the owner.
     */
    approvalState: text("approval_state").notNull().default("not_needed"),
    itemsTotalCents: integer("items_total_cents").notNull(),
    vatCents: integer("vat_cents").notNull(),
    nonVatCents: integer("non_vat_cents").notNull(),
    /** Exchange credit applied to the new sale (not paid out). */
    creditCents: integer("credit_cents").notNull().default(0),
    cashRoundingCents: integer("cash_rounding_cents").notNull(),
    /** Total paid out by the legs: items + non-VAT - credit + rounding. */
    amountCents: integer("amount_cents").notNull(),
    /** What the till showed; the server's own sum must match. */
    clientAmountCents: integer("client_amount_cents").notNull(),
    /** For an exchange: the sale the returned goods were exchanged into (no FK: the refund syncs first). */
    exchangeSaleId: uuid("exchange_sale_id"),
    createdAt: createdAtCol(),
  },
  (t) => [
    unique("refunds_org_id_id_key").on(t.orgId, t.id),
    unique("refunds_org_register_seq_key").on(t.orgId, t.registerId, t.receiptSeq),
    foreignKey({
      name: "refunds_org_register_fk",
      columns: [t.orgId, t.registerId],
      foreignColumns: [registers.orgId, registers.id],
    }),
    foreignKey({
      name: "refunds_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    foreignKey({
      name: "refunds_org_sale_fk",
      columns: [t.orgId, t.originalSaleId],
      foreignColumns: [sales.orgId, sales.id],
    }),
    index("refunds_org_created_idx").on(t.orgId, t.createdAt),
    index("refunds_org_sale_idx").on(t.orgId, t.originalSaleId),
    check("refunds_kind", sql`${t.kind} in ('refund', 'void', 'exchange')`),
    check(
      "refunds_reason_code",
      sql`${t.reasonCode} in ('changed_mind', 'faulty', 'wrong_item', 'damaged', 'void_mistake', 'other')`,
    ),
    check(
      "refunds_reason_note",
      sql`(${t.reasonNote} is null or char_length(${t.reasonNote}) <= 200)
        and (${t.reasonCode} <> 'other' or char_length(btrim(coalesce(${t.reasonNote}, ''))) > 0)`,
    ),
    check(
      "refunds_approval_state",
      sql`${t.approvalState} in ('not_needed', 'verified', 'self', 'unverified')`,
    ),
    check("refunds_receipt_seq", sql`${t.receiptSeq} between 1 and 99999999`),
    check(
      "refunds_amounts",
      sql`${t.itemsTotalCents} >= 0 and ${t.vatCents} >= 0 and ${t.nonVatCents} >= 0
        and ${t.creditCents} >= 0 and ${t.amountCents} >= 0
        and ${t.cashRoundingCents} between -2 and 2
        and ${t.amountCents} = ${t.itemsTotalCents} + ${t.nonVatCents} - ${t.creditCents} + ${t.cashRoundingCents}`,
    ),
    check("refunds_amount_close", sql`abs(${t.amountCents} - ${t.clientAmountCents}) <= 1`),
    check(
      "refunds_exchange",
      sql`(${t.kind} = 'exchange') = (${t.exchangeSaleId} is not null)
        and (${t.kind} = 'exchange' or ${t.creditCents} = 0)`,
    ),
  ],
);

/** One returned line, with the ORIGINAL line's rate copied across. Append-only. */
export const refundLines = pgTable(
  "refund_lines",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    refundId: uuid("refund_id").notNull(),
    saleLineId: uuid("sale_line_id").notNull(),
    lineNo: integer("line_no").notNull(),
    kind: text("kind").notNull().default("item"),
    variantId: uuid("variant_id"),
    name: text("name").notNull(),
    qty: integer("qty").notNull(),
    serial: text("serial"),
    /** Put the units back into stock (off for a damaged or faulty return). */
    restock: boolean("restock").notNull().default(true),
    taxCategory: text("tax_category"),
    taxRateBp: integer("tax_rate_bp"),
    netCents: integer("net_cents"),
    vatCents: integer("vat_cents"),
    grossCents: integer("gross_cents").notNull(),
    createdAt: createdAtCol(),
  },
  (t) => [
    unique("refund_lines_refund_line_key").on(t.refundId, t.lineNo),
    foreignKey({
      name: "refund_lines_org_refund_fk",
      columns: [t.orgId, t.refundId],
      foreignColumns: [refunds.orgId, refunds.id],
    }),
    foreignKey({
      name: "refund_lines_org_sale_line_fk",
      columns: [t.orgId, t.saleLineId],
      foreignColumns: [saleLines.orgId, saleLines.id],
    }),
    index("refund_lines_org_refund_idx").on(t.orgId, t.refundId),
    index("refund_lines_org_sale_line_idx").on(t.orgId, t.saleLineId),
    check("refund_lines_kind", sql`${t.kind} in ('item', 'deposit')`),
    check("refund_lines_qty", sql`${t.qty} between 1 and 999`),
    check("refund_lines_gross", sql`${t.grossCents} >= 0`),
    check(
      "refund_lines_snapshot",
      sql`(${t.kind} = 'item' and ${t.taxRateBp} is not null and ${t.netCents} is not null and ${t.vatCents} is not null and ${t.taxCategory} is not null and ${t.netCents} + ${t.vatCents} = ${t.grossCents})
        or (${t.kind} = 'deposit' and ${t.taxRateBp} is null)`,
    ),
  ],
);

/** How the money went back (or, for `exchange`, the credit applied to the new sale). */
export const refundPayments = pgTable(
  "refund_payments",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    refundId: uuid("refund_id").notNull(),
    tenderTypeId: uuid("tender_type_id"),
    label: text("label"),
    method: text("method").notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** A card tip handed back; only on a void, and outside `amount_cents`. */
    tipCents: integer("tip_cents").notNull().default(0),
    /** Terminal receipt reference or voucher number; never a card number. */
    providerRef: text("provider_ref"),
    createdAt: createdAtCol(),
  },
  (t) => [
    foreignKey({
      name: "refund_payments_org_refund_fk",
      columns: [t.orgId, t.refundId],
      foreignColumns: [refunds.orgId, refunds.id],
    }),
    foreignKey({
      name: "refund_payments_org_tender_type_fk",
      columns: [t.orgId, t.tenderTypeId],
      foreignColumns: [tenderTypes.orgId, tenderTypes.id],
    }),
    index("refund_payments_org_refund_idx").on(t.orgId, t.refundId),
    index("refund_payments_org_created_idx").on(t.orgId, t.createdAt),
    check("refund_payments_method", sql`${t.method} in ('cash', 'card', 'voucher', 'exchange')`),
    check("refund_payments_amount", sql`${t.amountCents} >= 0`),
    check(
      "refund_payments_tip",
      sql`${t.tipCents} = 0 or (${t.method} = 'card' and ${t.tipCents} <= ${t.amountCents})`,
    ),
    check(
      "refund_payments_provider_ref",
      sql`${t.providerRef} is null or (char_length(${t.providerRef}) <= 40 and ${t.providerRef} ~ '^[A-Za-z0-9 /-]*$' and char_length(regexp_replace(${t.providerRef}, '[^0-9]', '', 'g')) < 13)`,
    ),
  ],
);

export const syncRejectionReasons = [
  "invalid",
  "unknown_item",
  "modifier_not_offered",
  "price_mismatch",
  "short_tender",
  "bad_time",
  "receipt_number_used",
  "cannot_price",
  "discount_needs_approval",
  "tender_mismatch",
  "unknown_tender",
  "refund_exceeds",
  "refund_mismatch",
  "refund_needs_approval",
  "void_not_allowed",
  "original_not_found",
  "refund_unverified",
] as const;

/** A sale the server refused: the manager's "Needs attention" list. `id` is the sale id. */
export const syncRejections = pgTable(
  "sync_rejections",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    registerId: uuid("register_id"),
    reason: text("reason").notNull(),
    detail: jsonb("detail")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The sale's cart inputs as the till sent them (no customer or invoice data). */
    payload: jsonb("payload").notNull(),
    status: text("status").notNull().default("open"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    note: text("note"),
    createdAt: createdAtCol(),
  },
  (t) => [
    index("sync_rejections_org_status_idx").on(t.orgId, t.status, t.createdAt),
    check("sync_rejections_status", sql`${t.status} in ('open', 'resolved')`),
    check("sync_rejections_note_len", sql`${t.note} is null or char_length(${t.note}) <= 500`),
    check("sync_rejections_payload_size", sql`pg_column_size(${t.payload}) <= 65536`),
  ],
);

/** Price in force over time, so an offline sale is priced at what the till showed. Append-only. */
export const variantPriceHistory = pgTable(
  "variant_price_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgCol(),
    variantId: uuid("variant_id").notNull(),
    productId: uuid("product_id").notNull(),
    priceInclVatCents: integer("price_incl_vat_cents").notNull(),
    depositCents: integer("deposit_cents").notNull().default(0),
    taxCategory: text("tax_category").notNull(),
    takeawayTaxCategory: text("takeaway_tax_category"),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "variant_price_history_org_variant_fk",
      columns: [t.orgId, t.variantId],
      foreignColumns: [variants.orgId, variants.id],
    }),
    foreignKey({
      name: "variant_price_history_org_product_fk",
      columns: [t.orgId, t.productId],
      foreignColumns: [products.orgId, products.id],
    }),
    index("variant_price_history_lookup_idx").on(t.orgId, t.variantId, t.validFrom),
  ],
);

export const modifierPriceHistory = pgTable(
  "modifier_price_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: orgCol(),
    modifierId: uuid("modifier_id").notNull(),
    groupId: uuid("group_id").notNull(),
    name: text("name").notNull(),
    priceDeltaCents: integer("price_delta_cents").notNull(),
    validFrom: timestamp("valid_from", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // No FK to modifiers: a deleted option must stay priceable for sales made before the delete.
    index("modifier_price_history_lookup_idx").on(t.orgId, t.modifierId, t.validFrom),
  ],
);

export type Sale = typeof sales.$inferSelect;
export type SaleLine = typeof saleLines.$inferSelect;
export type SyncRejection = typeof syncRejections.$inferSelect;
export type Refund = typeof refunds.$inferSelect;
export type RefundLine = typeof refundLines.$inferSelect;
