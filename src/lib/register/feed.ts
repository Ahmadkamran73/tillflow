import { z } from "zod";
import { businessTypes } from "@/config/business-type-presets";
import { TAX_CATEGORIES } from "@/lib/money";

// Shared by the "changes since cursor" endpoint (server) and the register's local cache (client).
// No cost prices: cashiers don't need them on the device.
const taxCategory = z.enum(TAX_CATEGORIES);

export const feedSchema = z.object({
  /** Send back as `since` next time. Overlaps the previous read by a minute; upserts are idempotent. */
  cursor: z.iso.datetime(),
  /** True for a first load: the device replaces everything it holds. */
  full: z.boolean(),
  org: z.object({
    businessType: z.enum(businessTypes),
    timezone: z.string(),
    country: z.string(),
    // Receipt header (printed on every receipt).
    name: z.string(),
    legalName: z.string().nullable(),
    vatNumber: z.string().nullable(),
    address: z.string().nullable(),
    eircode: z.string().nullable(),
    receiptFooter: z.string().nullable(),
    /** A discount above this share (basis points) of a line or the sale needs a manager's PIN. */
    discountOverrideBp: z.int().min(0).max(10_000),
    /** A cashier's refund above this many cents needs a manager's PIN (organisations.refund_override_cents). */
    refundOverrideCents: z.int().min(0).max(1_000_000).default(2000),
    /** Restaurant service charge in basis points of the eat-in bill; 0 = none. */
    serviceChargeBp: z.int().min(0).max(2500).default(0),
  }),
  /** Restaurants: the dining areas and tables of this till's location (live ones only). */
  floors: z.array(z.object({ id: z.string(), name: z.string(), sort: z.int() })).default([]),
  tables: z
    .array(
      z.object({
        id: z.string(),
        floorId: z.string(),
        name: z.string(),
        seats: z.int(),
        shape: z.enum(["square", "round", "rect"]),
        x: z.int(),
        y: z.int(),
        w: z.int(),
        h: z.int(),
      }),
    )
    .default([]),
  /** Who can unlock the till: staff of this shop who have set a PIN. The Argon2 hashes let a till check a PIN offline. */
  staff: z.array(
    z.object({
      userId: z.string(),
      displayName: z.string(),
      role: z.enum(["owner", "manager", "cashier"]),
      pinHash: z.string(),
    }),
  ),
  /** Only the till this device is paired to. */
  registers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** Highest receipt number the server holds for this till (0 = none), so numbering carries on after it. */
      lastSeq: z.int().min(0).default(0),
      /** Highest refund number the server holds for this till, so refund numbering carries on after it. */
      lastRefundSeq: z.int().min(0).default(0),
    }),
  ),
  /** The ways this till's location takes payment (archived ones are not sent). */
  tenderTypes: z
    .array(
      z.object({
        id: z.string(),
        method: z.enum(["cash", "card"]),
        label: z.string(),
        sort: z.int(),
      }),
    )
    .default([]),
  /** Server clock when the feed was read; the device shows a warning if its own clock is far off. */
  serverTime: z.iso.datetime(),
  taxRates: z.array(
    z.object({
      country: z.string(),
      code: z.string(),
      rateBp: z.int(),
      validFrom: z.string(),
      validTo: z.string().nullable(),
    }),
  ),
  categories: z.array(
    z.object({ id: z.string(), name: z.string(), colour: z.string().nullable(), sort: z.int() }),
  ),
  products: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      categoryId: z.string().nullable(),
      taxCategory,
      takeawayTaxCategory: taxCategory.nullable(),
      archived: z.boolean(),
    }),
  ),
  variants: z.array(
    z.object({
      id: z.string(),
      productId: z.string(),
      name: z.string(),
      sku: z.string().nullable(),
      barcode: z.string().nullable(),
      priceCents: z.int(),
      sort: z.int(),
      attributes: z.record(z.string(), z.unknown()),
      archived: z.boolean(),
    }),
  ),
  modifierGroups: z.array(
    z.object({ id: z.string(), name: z.string(), min: z.int(), max: z.int(), sort: z.int() }),
  ),
  modifiers: z.array(
    z.object({
      id: z.string(),
      groupId: z.string(),
      name: z.string(),
      priceDeltaCents: z.int(),
      sort: z.int(),
    }),
  ),
  productGroups: z.array(
    z.object({ id: z.string(), productId: z.string(), groupId: z.string(), sort: z.int() }),
  ),
});

export type Feed = z.infer<typeof feedSchema>;

/** The shop default (organisations.discount_override_bp): 10% off needs no manager PIN, more does. */
export const DEFAULT_DISCOUNT_LIMIT_BP = 1000;

/**
 * The discount limit from the till's saved copy of the shop. A copy saved before the limit existed
 * has none: use the default until the next catalogue pull brings the real one, instead of crashing
 * the register (which would also stop that pull from ever running).
 */
export const discountLimitOf = (org: { discountOverrideBp?: number } | undefined): number =>
  typeof org?.discountOverrideBp === "number" &&
  Number.isInteger(org.discountOverrideBp) &&
  org.discountOverrideBp >= 0 &&
  org.discountOverrideBp <= 10_000
    ? org.discountOverrideBp
    : DEFAULT_DISCOUNT_LIMIT_BP;
/** The shop default (organisations.refund_override_cents): a cashier's refund above EUR 20.00 needs a manager. */
export const DEFAULT_REFUND_LIMIT_CENTS = 2000;

/** The refund limit from the till's saved copy of the shop; a copy from before refunds has none. */
export const refundLimitOf = (org: { refundOverrideCents?: number } | undefined): number =>
  typeof org?.refundOverrideCents === "number" &&
  Number.isInteger(org.refundOverrideCents) &&
  org.refundOverrideCents >= 0 &&
  org.refundOverrideCents <= 1_000_000
    ? org.refundOverrideCents
    : DEFAULT_REFUND_LIMIT_CENTS;
export type FeedProduct = Feed["products"][number];
export type FeedVariant = Feed["variants"][number];
