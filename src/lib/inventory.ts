import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth";
import { cleanSearch, PAGE_SIZE } from "@/lib/catalog";
import { stockStatus, valuation, type StockStatus } from "@/lib/inventory-status";

export const FILTERS = ["all", "low", "out", "negative"] as const;
export type StockFilter = (typeof FILTERS)[number];

const id = z.string();

/** PostgREST caps a response at 1000 rows: read in pages. */
async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error("Could not load stock");
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

/**
 * Every stock-tracked, non-archived variant with its on-hand, cost and status. Managers and owners
 * only (costs). Filtering and paging happen here, in memory: fine for a shop's catalogue.
 * ponytail: in-memory over the whole catalogue; move to a SQL view if a shop passes ~20k variants.
 */
export async function listStock(
  orgId: string,
  locationId: string,
  { q, filter, page }: { q?: string; filter: StockFilter; page: number },
) {
  const supabase = await createSupabaseServerClient();
  const [products, variants, levels, costs] = await Promise.all([
    fetchAll((a, b) =>
      supabase
        .from("products")
        .select("id, name, low_stock_threshold")
        .eq("org_id", orgId)
        .eq("track_stock", true)
        .is("archived_at", null)
        .order("id")
        .range(a, b),
    ),
    fetchAll((a, b) =>
      supabase
        .from("variants")
        .select("id, product_id, name, sku, barcode, sort")
        .eq("org_id", orgId)
        .is("archived_at", null)
        .order("id")
        .range(a, b),
    ),
    fetchAll((a, b) =>
      supabase
        .from("stock_levels")
        .select("variant_id, on_hand")
        .eq("org_id", orgId)
        .eq("location_id", locationId)
        .order("id")
        .range(a, b),
    ),
    fetchAll((a, b) =>
      supabase
        .from("variant_costs")
        .select("variant_id, cost_cents")
        .eq("org_id", orgId)
        .order("variant_id")
        .range(a, b),
    ),
  ]);

  const productRows = z
    .array(z.object({ id, name: z.string(), low_stock_threshold: z.number().nullable() }))
    .parse(products);
  const variantRows = z
    .array(
      z.object({
        id,
        product_id: id,
        name: z.string(),
        sku: z.string().nullable(),
        barcode: z.string().nullable(),
        sort: z.number(),
      }),
    )
    .parse(variants);
  const onHand = new Map(
    z
      .array(z.object({ variant_id: id, on_hand: z.number() }))
      .parse(levels)
      .map((l) => [l.variant_id, l.on_hand]),
  );
  const costOf = new Map(
    z
      .array(z.object({ variant_id: id, cost_cents: z.number() }))
      .parse(costs)
      .map((c) => [c.variant_id, c.cost_cents]),
  );
  const productOf = new Map(productRows.map((p) => [p.id, p]));

  const mine = variantRows.filter((v) => productOf.has(v.product_id));
  const totals = new Map<string, number>();
  for (const v of mine) {
    totals.set(v.product_id, (totals.get(v.product_id) ?? 0) + (onHand.get(v.id) ?? 0));
  }

  const all = mine
    .map((v) => {
      const p = productOf.get(v.product_id)!;
      const total = totals.get(v.product_id)!;
      const status = stockStatus(total, p.low_stock_threshold);
      const qty = onHand.get(v.id) ?? 0;
      const cost = costOf.get(v.id) ?? null;
      return {
        variantId: v.id,
        productId: p.id,
        name: v.name ? `${p.name} · ${v.name}` : p.name,
        sku: v.sku,
        barcode: v.barcode,
        onHand: qty,
        productTotal: total,
        threshold: p.low_stock_threshold,
        costCents: cost,
        valueCents: cost !== null && qty > 0 ? cost * qty : null,
        status,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.variantId.localeCompare(b.variantId));

  const search = cleanSearch(q).toLowerCase();
  const matches = (s: StockStatus) =>
    filter === "all" ||
    (filter === "low" && (s === "low" || s === "out" || s === "negative")) ||
    (filter === "out" && (s === "out" || s === "negative")) ||
    (filter === "negative" && s === "negative");
  // A negative variant inside a healthy product still needs flagging.
  const rows = all.filter(
    (r) =>
      (matches(r.status) || (filter === "negative" && r.onHand < 0)) &&
      (!search ||
        r.name.toLowerCase().includes(search) ||
        r.sku?.toLowerCase() === search ||
        r.barcode?.toLowerCase() === search),
  );

  return {
    total: rows.length,
    rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    value: valuation(all),
    lowProducts: new Set(
      all
        .filter((r) => r.status === "low" || r.status === "out" || r.status === "negative")
        .map((r) => r.productId),
    ).size,
    negativeItems: all.filter((r) => r.onHand < 0).length,
  };
}

export async function getVariantStock(orgId: string, locationId: string, variantId: string) {
  if (!z.uuid().safeParse(variantId).success) return null;
  const supabase = await createSupabaseServerClient();
  const { data: v } = await supabase
    .from("variants")
    .select("id, product_id, name")
    .eq("org_id", orgId)
    .eq("id", variantId)
    .is("archived_at", null)
    .maybeSingle();
  if (!v) return null;
  const { data: p } = await supabase
    .from("products")
    .select("id, name, track_stock, low_stock_threshold")
    .eq("org_id", orgId)
    .eq("id", v.product_id)
    .eq("track_stock", true)
    .is("archived_at", null)
    .maybeSingle();
  if (!p) return null;
  const { data: siblings } = await supabase
    .from("variants")
    .select("id")
    .eq("org_id", orgId)
    .eq("product_id", p.id)
    .is("archived_at", null);
  const { data: levels } = await supabase
    .from("stock_levels")
    .select("variant_id, on_hand")
    .eq("org_id", orgId)
    .eq("location_id", locationId)
    .in(
      "variant_id",
      (siblings ?? []).map((s) => s.id),
    );
  const rows = z.array(z.object({ variant_id: id, on_hand: z.number() })).parse(levels ?? []);
  const onHand = rows.find((r) => r.variant_id === variantId)?.on_hand ?? 0;
  const productTotal = rows.reduce((n, r) => n + r.on_hand, 0);
  const { data: moves } = await supabase
    .from("stock_movements")
    .select("id, created_at, reason, qty_delta, note")
    .eq("org_id", orgId)
    .eq("variant_id", variantId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  return {
    productId: p.id,
    name: v.name ? `${p.name} · ${v.name}` : p.name,
    threshold: p.low_stock_threshold as number | null,
    onHand,
    productTotal,
    movements: z
      .array(
        z.object({
          id,
          created_at: z.string(),
          reason: z.string(),
          qty_delta: z.number(),
          note: z.string().nullable(),
        }),
      )
      .parse(moves ?? []),
  };
}
