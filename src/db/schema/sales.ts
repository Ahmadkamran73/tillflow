import { sql } from "drizzle-orm";
import {
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
    method: text("method").notNull(),
    amountCents: integer("amount_cents").notNull(),
    tenderedCents: integer("tendered_cents").notNull(),
    changeCents: integer("change_cents").notNull(),
    tipCents: integer("tip_cents").notNull().default(0),
    /** Terminal receipt reference for card tenders (step 2.1); never a card number. */
    providerRef: text("provider_ref"),
    createdAt: createdAtCol(),
  },
  (t) => [
    foreignKey({
      name: "payments_org_sale_fk",
      columns: [t.orgId, t.saleId],
      foreignColumns: [sales.orgId, sales.id],
    }),
    index("payments_org_sale_idx").on(t.orgId, t.saleId),
    check("payments_method", sql`${t.method} in ('cash', 'card', 'voucher')`),
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
