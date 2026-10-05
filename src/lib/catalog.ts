import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth";
import type { RateRow } from "@/lib/money";

export const PAGE_SIZE = 25;

const uuid = z.string();
const productRow = z.object({
  id: uuid,
  name: z.string(),
  category_id: z.string().nullable(),
  tax_category: z.string(),
  takeaway_tax_category: z.string().nullable(),
  track_stock: z.boolean(),
});
const variantRow = z.object({
  id: uuid,
  product_id: uuid,
  name: z.string(),
  sku: z.string().nullable(),
  barcode: z.string().nullable(),
  price_incl_vat_cents: z.number(),
  attributes: z.record(z.string(), z.unknown()),
});

/** The shop's single location (v1). Needed for opening stock and the VAT date. */
export async function getLocation(orgId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("locations")
    .select("id, timezone")
    .eq("org_id", orgId)
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return z.object({ id: uuid, timezone: z.string() }).parse(data);
}

/** Irish VAT rates, effective-dated (global reference data, readable by every member). */
export async function getTaxRates(): Promise<RateRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tax_rates")
    .select("country, code, rate_bp, valid_from, valid_to")
    .eq("country", "IE");
  if (error) throw new Error("Could not load VAT rates");
  return z
    .array(
      z.object({
        country: z.string(),
        code: z.string(),
        rate_bp: z.number(),
        valid_from: z.string(),
        valid_to: z.string().nullable(),
      }),
    )
    .parse(data)
    .map((r) => ({
      country: r.country,
      code: r.code,
      rateBp: r.rate_bp,
      validFrom: r.valid_from,
      validTo: r.valid_to,
    }));
}

/** Letters, digits, spaces and a few name characters only: the value goes into a PostgREST filter. */
export function cleanSearch(q: string | undefined) {
  return (q ?? "")
    .replace(/[^\p{L}\p{N} '&.-]/gu, "")
    .trim()
    .slice(0, 60);
}

export async function listProducts(
  orgId: string,
  { q, categoryId, page }: { q?: string; categoryId?: string; page: number },
) {
  const supabase = await createSupabaseServerClient();
  const search = cleanSearch(q);

  let query = supabase
    .from("products")
    .select("id, name, category_id, tax_category, takeaway_tax_category, track_stock", {
      count: "exact",
    })
    .eq("org_id", orgId)
    .is("archived_at", null)
    .order("name")
    .order("id")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (categoryId && z.uuid().safeParse(categoryId).success)
    query = query.eq("category_id", categoryId);
  if (search) {
    // An exact SKU or barcode also finds the product, whatever its name.
    const { data: hits } = await supabase
      .from("variants")
      .select("product_id")
      .eq("org_id", orgId)
      .or(`barcode.eq."${search}",sku.eq."${search}"`);
    const ids = z
      .array(z.object({ product_id: uuid }))
      .parse(hits ?? [])
      .map((h) => h.product_id);
    query = query.or(
      ids.length ? `name.ilike."*${search}*",id.in.(${ids.join(",")})` : `name.ilike."*${search}*"`,
    );
  }
  const { data, count, error } = await query;
  if (error) throw new Error("Could not load products");
  const products = z.array(productRow).parse(data);

  const ids = products.map((p) => p.id);
  const { data: vdata } = ids.length
    ? await supabase
        .from("variants")
        .select("id, product_id, name, sku, barcode, price_incl_vat_cents, attributes")
        .eq("org_id", orgId)
        .is("archived_at", null)
        .in("product_id", ids)
        .order("sort")
    : { data: [] };
  const variants = z.array(variantRow).parse(vdata ?? []);
  const vids = variants.map((v) => v.id);
  const { data: sdata } = vids.length
    ? await supabase
        .from("stock_levels")
        .select("variant_id, on_hand")
        .eq("org_id", orgId)
        .in("variant_id", vids)
    : { data: [] };
  const onHand = new Map<string, number>();
  for (const s of z.array(z.object({ variant_id: uuid, on_hand: z.number() })).parse(sdata ?? [])) {
    onHand.set(s.variant_id, (onHand.get(s.variant_id) ?? 0) + s.on_hand);
  }

  return {
    total: count ?? 0,
    rows: products.map((p) => {
      const mine = variants.filter((v) => v.product_id === p.id);
      const prices = mine.map((v) => v.price_incl_vat_cents);
      return {
        id: p.id,
        name: p.name,
        categoryId: p.category_id,
        trackStock: p.track_stock,
        variantCount: mine.length,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        barcode: mine.length === 1 ? mine[0]!.barcode : null,
        onHand: mine.reduce((sum, v) => sum + (onHand.get(v.id) ?? 0), 0),
      };
    }),
  };
}

export async function getProduct(orgId: string, productId: string) {
  if (!z.uuid().safeParse(productId).success) return null;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("products")
    .select("id, name, category_id, tax_category, takeaway_tax_category, track_stock")
    .eq("org_id", orgId)
    .eq("id", productId)
    .is("archived_at", null)
    .maybeSingle();
  if (!data) return null;
  const p = productRow.parse(data);
  const { data: vdata } = await supabase
    .from("variants")
    .select("id, product_id, name, sku, barcode, price_incl_vat_cents, attributes")
    .eq("org_id", orgId)
    .eq("product_id", productId)
    .is("archived_at", null)
    .order("sort");
  // Cost prices sit in their own table that only managers and owners can read (this page is theirs).
  const { data: cdata } = await supabase
    .from("variant_costs")
    .select("variant_id, cost_cents")
    .eq("org_id", orgId);
  const costOf = new Map(
    z
      .array(z.object({ variant_id: uuid, cost_cents: z.number() }))
      .parse(cdata ?? [])
      .map((c) => [c.variant_id, c.cost_cents]),
  );
  const { data: gdata } = await supabase
    .from("product_modifier_groups")
    .select("group_id")
    .eq("org_id", orgId)
    .eq("product_id", productId)
    .order("sort");
  return {
    id: p.id,
    name: p.name,
    categoryId: p.category_id,
    taxCategory: p.tax_category,
    takeawayTaxCategory: p.takeaway_tax_category,
    trackStock: p.track_stock,
    modifierGroupIds: z
      .array(z.object({ group_id: uuid }))
      .parse(gdata ?? [])
      .map((g) => g.group_id),
    variants: z
      .array(variantRow)
      .parse(vdata ?? [])
      .map((v) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode,
        priceInclVatCents: v.price_incl_vat_cents,
        costCents: costOf.get(v.id) ?? null,
        attributes: v.attributes,
      })),
  };
}

export async function listModifierGroups(orgId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("modifier_groups")
    .select("id, name, min_choices, max_choices")
    .eq("org_id", orgId)
    .order("sort")
    .order("name");
  if (error) throw new Error("Could not load modifier groups");
  const groups = z
    .array(
      z.object({ id: uuid, name: z.string(), min_choices: z.number(), max_choices: z.number() }),
    )
    .parse(data);
  const { data: odata } = await supabase
    .from("modifiers")
    .select("id, group_id, name, price_delta_cents")
    .eq("org_id", orgId)
    .order("sort");
  const options = z
    .array(z.object({ id: uuid, group_id: uuid, name: z.string(), price_delta_cents: z.number() }))
    .parse(odata ?? []);
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    min: g.min_choices,
    max: g.max_choices,
    options: options
      .filter((o) => o.group_id === g.id)
      .map((o) => ({ id: o.id, name: o.name, priceDeltaCents: o.price_delta_cents })),
  }));
}

export async function getModifierGroup(orgId: string, groupId: string) {
  if (!z.uuid().safeParse(groupId).success) return null;
  return (await listModifierGroups(orgId)).find((g) => g.id === groupId) ?? null;
}
