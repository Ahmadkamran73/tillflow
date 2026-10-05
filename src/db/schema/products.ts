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
import { categories } from "./catalog";
import { locations, organisations } from "./tenancy";

const createdAtCol = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAtCol = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const orgCol = () =>
  uuid("org_id")
    .notNull()
    .references(() => organisations.id);

// Keep in step with TAX_CATEGORIES in src/lib/money/rates.ts (a unit test compares the two).
const TAX_CATEGORY_SQL = sql.raw(
  "('STANDARD','REDUCED','SECOND_REDUCED','ZERO','LIVESTOCK','CATERING','HAIRDRESSING')",
);

/** A sellable item. Price, barcode and stock live on its variants. Archived, never deleted. */
export const products = pgTable(
  "products",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    name: text("name").notNull(),
    categoryId: uuid("category_id"),
    taxCategory: text("tax_category").notNull(),
    takeawayTaxCategory: text("takeaway_tax_category"),
    trackStock: boolean("track_stock").notNull().default(true),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("products_org_id_id_key").on(t.orgId, t.id),
    foreignKey({
      name: "products_org_category_fk",
      columns: [t.orgId, t.categoryId],
      foreignColumns: [categories.orgId, categories.id],
    }),
    index("products_org_name_idx").on(t.orgId, t.name),
    index("products_org_category_idx").on(t.orgId, t.categoryId),
    check("products_name_len", sql`char_length(${t.name}) between 1 and 120`),
    check("products_tax_category", sql`${t.taxCategory} in ${TAX_CATEGORY_SQL}`),
    check(
      "products_takeaway_tax_category",
      sql`${t.takeawayTaxCategory} is null or ${t.takeawayTaxCategory} in ${TAX_CATEGORY_SQL}`,
    ),
    // Carried forward from the money library: catering sold take-away must say what it becomes.
    check(
      "products_catering_takeaway",
      sql`${t.taxCategory} <> 'CATERING' or ${t.takeawayTaxCategory} is not null`,
    ),
  ],
);

/** What is actually sold: VAT-inclusive price, barcode, SKU. `attributes` is per business type. */
export const variants = pgTable(
  "variants",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    productId: uuid("product_id").notNull(),
    name: text("name").notNull().default(""),
    sku: text("sku"),
    barcode: text("barcode"),
    priceInclVatCents: integer("price_incl_vat_cents").notNull(),
    costCents: integer("cost_cents"),
    attributes: jsonb("attributes")
      .notNull()
      .default(sql`'{}'::jsonb`),
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("variants_org_id_id_key").on(t.orgId, t.id),
    unique("variants_org_barcode_key").on(t.orgId, t.barcode),
    unique("variants_org_sku_key").on(t.orgId, t.sku),
    foreignKey({
      name: "variants_org_product_fk",
      columns: [t.orgId, t.productId],
      foreignColumns: [products.orgId, products.id],
    }),
    index("variants_org_product_idx").on(t.orgId, t.productId),
    check("variants_price_range", sql`${t.priceInclVatCents} between 0 and 100000000`),
    check(
      "variants_cost_range",
      sql`${t.costCents} is null or ${t.costCents} between 0 and 100000000`,
    ),
    check(
      "variants_barcode_shape",
      sql`${t.barcode} is null or ${t.barcode} ~ '^[0-9A-Za-z-]{1,32}$'`,
    ),
    check("variants_sku_len", sql`${t.sku} is null or char_length(${t.sku}) between 1 and 40`),
  ],
);

export const stockReasons = ["opening", "adjustment", "sale", "refund"] as const;

/** Cached total per variant and location. Written only by the stock_movements trigger. */
export const stockLevels = pgTable(
  "stock_levels",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    variantId: uuid("variant_id").notNull(),
    locationId: uuid("location_id").notNull(),
    onHand: integer("on_hand").notNull().default(0),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("stock_levels_org_variant_location_key").on(t.orgId, t.variantId, t.locationId),
    foreignKey({
      name: "stock_levels_org_variant_fk",
      columns: [t.orgId, t.variantId],
      foreignColumns: [variants.orgId, variants.id],
    }),
    foreignKey({
      name: "stock_levels_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
  ],
);

/** Append-only stock ledger. Corrections are new rows. */
export const stockMovements = pgTable(
  "stock_movements",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    variantId: uuid("variant_id").notNull(),
    locationId: uuid("location_id").notNull(),
    qtyDelta: integer("qty_delta").notNull(),
    reason: text("reason").notNull(),
    refId: uuid("ref_id"),
    actorUserId: uuid("actor_user_id"),
    createdAt: createdAtCol(),
  },
  (t) => [
    foreignKey({
      name: "stock_movements_org_variant_fk",
      columns: [t.orgId, t.variantId],
      foreignColumns: [variants.orgId, variants.id],
    }),
    foreignKey({
      name: "stock_movements_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    index("stock_movements_org_variant_created_idx").on(t.orgId, t.variantId, t.createdAt),
    check(
      "stock_movements_qty",
      sql`${t.qtyDelta} <> 0 and ${t.qtyDelta} between -1000000 and 1000000`,
    ),
    check("stock_movements_reason", sql`${t.reason} in ('opening','adjustment','sale','refund')`),
  ],
);

export const modifierGroups = pgTable(
  "modifier_groups",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    name: text("name").notNull(),
    minChoices: integer("min_choices").notNull().default(0),
    maxChoices: integer("max_choices").notNull().default(1),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("modifier_groups_org_name_key").on(t.orgId, t.name),
    unique("modifier_groups_org_id_id_key").on(t.orgId, t.id),
    check("modifier_groups_name_len", sql`char_length(${t.name}) between 1 and 60`),
    check(
      "modifier_groups_choices",
      sql`${t.minChoices} >= 0 and ${t.minChoices} <= ${t.maxChoices} and ${t.maxChoices} <= 20`,
    ),
  ],
);

export const modifiers = pgTable(
  "modifiers",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    groupId: uuid("group_id").notNull(),
    name: text("name").notNull(),
    priceDeltaCents: integer("price_delta_cents").notNull().default(0),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("modifiers_org_group_name_key").on(t.orgId, t.groupId, t.name),
    foreignKey({
      name: "modifiers_org_group_fk",
      columns: [t.orgId, t.groupId],
      foreignColumns: [modifierGroups.orgId, modifierGroups.id],
    }).onDelete("cascade"),
    index("modifiers_org_group_idx").on(t.orgId, t.groupId),
    check("modifiers_name_len", sql`char_length(${t.name}) between 1 and 60`),
    check("modifiers_price_delta", sql`${t.priceDeltaCents} between -100000 and 100000`),
  ],
);

export const productModifierGroups = pgTable(
  "product_modifier_groups",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    productId: uuid("product_id").notNull(),
    groupId: uuid("group_id").notNull(),
    sort: integer("sort").notNull().default(0),
    createdAt: createdAtCol(),
  },
  (t) => [
    unique("product_modifier_groups_org_product_group_key").on(t.orgId, t.productId, t.groupId),
    foreignKey({
      name: "product_modifier_groups_org_product_fk",
      columns: [t.orgId, t.productId],
      foreignColumns: [products.orgId, products.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "product_modifier_groups_org_group_fk",
      columns: [t.orgId, t.groupId],
      foreignColumns: [modifierGroups.orgId, modifierGroups.id],
    }).onDelete("cascade"),
    index("product_modifier_groups_org_group_idx").on(t.orgId, t.groupId),
  ],
);

export type Product = typeof products.$inferSelect;
export type Variant = typeof variants.$inferSelect;
