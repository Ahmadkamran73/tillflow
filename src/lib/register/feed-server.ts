import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth";
import { getTaxRates } from "@/lib/catalog";
import { getOrganisation } from "@/lib/org";
import { feedSchema, type Feed } from "./feed";

const PAGE = 1000; // PostgREST's default row cap

type Page = PromiseLike<{ data: unknown[] | null; error: unknown }>;

/** Reads every row of a query, a page at a time (the API caps one response at 1,000 rows). */
async function all(page: (from: number, to: number) => Page): Promise<unknown[]> {
  const rows: unknown[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error("Could not load the catalogue");
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) return rows;
  }
}

/**
 * The catalogue as the register needs it. Products and variants are never deleted (archived),
 * so `since` works as "updated since"; archived rows are sent so the device can drop them.
 * The small tables (categories, modifiers) are sent whole every time because rows can be deleted.
 * Runs as the caller (RLS applies).
 */
export async function getCatalogFeed(orgId: string, since: string | null): Promise<Feed | null> {
  const org = await getOrganisation(orgId);
  if (!org) return null;
  // Taken before the reads and backed off a minute, so a transaction that commits while we read
  // is picked up next time. The overlap is harmless: the device upserts by id.
  const cursor = new Date(Date.now() - 60_000).toISOString();
  const supabase = await createSupabaseServerClient();

  const changed = <T extends { gt: (c: string, v: string) => T; is: (c: string, v: null) => T }>(
    q: T,
  ) => (since ? q.gt("updated_at", since) : q.is("archived_at", null));

  const [loc, taxRates, categories, products, variants, groups, mods, pgroups] = await Promise.all([
    supabase.from("locations").select("timezone").eq("org_id", orgId).order("created_at").limit(1),
    getTaxRates(),
    all((a, b) =>
      supabase
        .from("categories")
        .select("id, name, colour, sort")
        .eq("org_id", orgId)
        .order("sort")
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      changed(
        supabase
          .from("products")
          .select("id, name, category_id, tax_category, takeaway_tax_category, archived_at")
          .eq("org_id", orgId),
      )
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      changed(
        supabase
          .from("variants")
          .select(
            "id, product_id, name, sku, barcode, price_incl_vat_cents, sort, attributes, archived_at",
          )
          .eq("org_id", orgId),
      )
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      supabase
        .from("modifier_groups")
        .select("id, name, min_choices, max_choices, sort")
        .eq("org_id", orgId)
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      supabase
        .from("modifiers")
        .select("id, group_id, name, price_delta_cents, sort")
        .eq("org_id", orgId)
        .order("id")
        .range(a, b),
    ),
    all((a, b) =>
      supabase
        .from("product_modifier_groups")
        .select("id, product_id, group_id, sort")
        .eq("org_id", orgId)
        .order("id")
        .range(a, b),
    ),
  ]);

  const timezone = loc.data?.[0]?.timezone;
  if (!timezone) throw new Error("Could not load the catalogue");
  const row = z.record(z.string(), z.any());
  const rows = (x: unknown[]) => z.array(row).parse(x);

  return feedSchema.parse({
    cursor,
    full: since === null,
    org: { businessType: org.businessType, timezone, country: "IE" },
    taxRates,
    categories: rows(categories),
    products: rows(products).map((p) => ({
      id: p.id,
      name: p.name,
      categoryId: p.category_id,
      taxCategory: p.tax_category,
      takeawayTaxCategory: p.takeaway_tax_category,
      archived: p.archived_at !== null,
    })),
    variants: rows(variants).map((v) => ({
      id: v.id,
      productId: v.product_id,
      name: v.name,
      sku: v.sku,
      barcode: v.barcode,
      priceCents: v.price_incl_vat_cents,
      sort: v.sort,
      attributes: v.attributes,
      archived: v.archived_at !== null,
    })),
    modifierGroups: rows(groups).map((g) => ({
      id: g.id,
      name: g.name,
      min: g.min_choices,
      max: g.max_choices,
      sort: g.sort,
    })),
    modifiers: rows(mods).map((m) => ({
      id: m.id,
      groupId: m.group_id,
      name: m.name,
      priceDeltaCents: m.price_delta_cents,
      sort: m.sort,
    })),
    productGroups: rows(pgroups).map((g) => ({
      id: g.id,
      productId: g.product_id,
      groupId: g.group_id,
      sort: g.sort,
    })),
  });
}
