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
