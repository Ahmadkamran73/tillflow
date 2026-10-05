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
  }),
  /** The shop's tills; the device picks one once (until pairing, step 1.7). */
  registers: z.array(z.object({ id: z.string(), name: z.string() })),
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
export type FeedProduct = Feed["products"][number];
export type FeedVariant = Feed["variants"][number];
