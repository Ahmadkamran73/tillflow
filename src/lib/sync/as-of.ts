import { z } from "zod";
import type { SaleRows } from "@/lib/register/sale-input";

// The JSON returned by public.sale_catalog_as_of (migration 0019): the catalogue as it stood at
// one moment, from the price-history tables. Pure mapping, so it is unit-tested without a database.
const asOfSchema = z.object({
  variants: z.array(
    z.object({
      id: z.uuid(),
      product_id: z.uuid(),
      name: z.string(),
      price_cents: z.int(),
      tax_category: z.string(),
      takeaway_tax_category: z.string().nullable(),
      attributes: z.record(z.string(), z.unknown()),
    }),
  ),
  products: z.array(z.object({ id: z.uuid(), name: z.string(), track_stock: z.boolean() })),
  modifiers: z.array(
    z.object({
      id: z.uuid(),
      group_id: z.uuid(),
      name: z.string(),
      price_delta_cents: z.int(),
    }),
  ),
  product_groups: z.array(z.object({ product_id: z.uuid(), group_id: z.uuid() })),
});

export function rowsFromAsOf(json: unknown): SaleRows {
  const a = asOfSchema.parse(json);
  const names = new Map(a.products.map((p) => [p.id, p.name]));
  // A product's VAT category is carried on each of its variants' history rows; they agree
  // (a category change writes a row for every variant at once), so the first one stands for all.
  const products = new Map<string, SaleRows["products"][number]>();
  for (const v of a.variants) {
    if (products.has(v.product_id) || !names.has(v.product_id)) continue;
    products.set(v.product_id, {
      id: v.product_id,
      name: names.get(v.product_id)!,
      taxCategory: v.tax_category,
      takeawayTaxCategory: v.takeaway_tax_category,
    });
  }
  return {
    variants: a.variants
      .filter((v) => products.has(v.product_id))
      .map((v) => ({
        id: v.id,
        productId: v.product_id,
        name: v.name,
        priceCents: v.price_cents,
        attributes: v.attributes,
      })),
    products: [...products.values()],
    modifiers: a.modifiers.map((m) => ({
      id: m.id,
      groupId: m.group_id,
      name: m.name,
      priceDeltaCents: m.price_delta_cents,
    })),
    productGroups: a.product_groups.map((g) => ({ productId: g.product_id, groupId: g.group_id })),
  };
}
