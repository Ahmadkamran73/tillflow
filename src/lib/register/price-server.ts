import "server-only";
import { createSupabaseServerClient } from "@/lib/auth";
import { getTaxRates } from "@/lib/catalog";
import { localDate } from "@/lib/money";
import { priceCart, type Cart, type PricedCart } from "./cart";
import { rowsFromAsOf } from "@/lib/sync/as-of";
import { buildServerCart, SaleError, type EmailReceiptInput, type SaleRows } from "./sale-input";

type PricingInput = Pick<EmailReceiptInput, "lines" | "basketDiscount" | "completedAt" | "mode">;

/**
 * The catalogue as it stood at `at`, from the price-history tables (RLS applies). Prices, VAT
 * categories, deposits and modifier deltas are those in force then; products created after `at`
 * are absent. Used by sale sync so a price changed while a till was offline does not reject its sales.
 */
export async function loadRowsAsOf(
  orgId: string,
  input: PricingInput,
  at: Date,
): Promise<SaleRows> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("sale_catalog_as_of", {
    p_org: orgId,
    p_variant_ids: [...new Set(input.lines.map((l) => l.variantId))],
    p_modifier_ids: [...new Set(input.lines.flatMap((l) => l.modifierIds))],
    p_at: at.toISOString(),
  });
  if (error || !data) throw new Error("Could not load the catalogue");
  return rowsFromAsOf(data);
}

/** Builds the cart from `rows` and prices it at the VAT rates of the sale’s own shop-local day. */
export function priceRows(
  input: PricingInput,
  rows: SaleRows,
  taxRates: Awaited<ReturnType<typeof getTaxRates>>,
  timezone: string,
): { cart: Cart; priced: PricedCart } {
  const cart = buildServerCart(input, rows);
  try {
    const priced = priceCart(cart, {
      country: "IE",
      date: localDate(new Date(input.completedAt), timezone),
      rates: taxRates,
    });
    return { cart, priced };
  } catch {
    // A discount that does not fit, or a missing VAT rate: the sale cannot be priced.
    throw new SaleError("cannot price");
  }
}

/**
 * Loads the catalogue rows a sale refers to, as the caller (RLS applies, so another shop's ids
 * simply come back empty and fail as "unknown item"), and prices the sale with src/lib/money.
 * Reused by sale sync in step 1.6.
 */
export async function priceSaleOnServer(
  orgId: string,
  input: Pick<EmailReceiptInput, "lines" | "basketDiscount" | "completedAt" | "mode">,
  timezone: string,
): Promise<{ cart: Cart; priced: PricedCart }> {
  const supabase = await createSupabaseServerClient();
  const variantIds = [...new Set(input.lines.map((l) => l.variantId))];
  const modifierIds = [...new Set(input.lines.flatMap((l) => l.modifierIds))];

  const { data: vs, error: ve } = await supabase
    .from("variants")
    .select("id, product_id, name, price_incl_vat_cents, attributes")
    .eq("org_id", orgId)
    .in("id", variantIds);
  if (ve || !vs) throw new Error("Could not load the catalogue");
  const productIds = [...new Set(vs.map((v) => v.product_id as string))];

  const [ps, ms, pg, taxRates] = await Promise.all([
    supabase
      .from("products")
      .select("id, name, tax_category, takeaway_tax_category")
      .eq("org_id", orgId)
      .in("id", productIds),
    modifierIds.length
      ? supabase
          .from("modifiers")
          .select("id, group_id, name, price_delta_cents")
          .eq("org_id", orgId)
          .in("id", modifierIds)
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from("product_modifier_groups")
      .select("product_id, group_id")
      .eq("org_id", orgId)
      .in("product_id", productIds),
    getTaxRates(),
  ]);
  if (ps.error || ms.error || pg.error || !ps.data || !ms.data || !pg.data)
    throw new Error("Could not load the catalogue");

  const rows: SaleRows = {
    variants: vs.map((v) => ({
      id: v.id,
      productId: v.product_id,
      name: v.name,
      priceCents: v.price_incl_vat_cents,
      attributes: v.attributes as Record<string, unknown>,
    })),
    products: ps.data.map((p) => ({
      id: p.id,
      name: p.name,
      taxCategory: p.tax_category,
      takeawayTaxCategory: p.takeaway_tax_category,
    })),
    modifiers: ms.data.map((m) => ({
      id: m.id,
      groupId: m.group_id,
      name: m.name,
      priceDeltaCents: m.price_delta_cents,
    })),
    productGroups: pg.data.map((g) => ({ productId: g.product_id, groupId: g.group_id })),
  };
  return priceRows(input, rows, taxRates, timezone);
}
