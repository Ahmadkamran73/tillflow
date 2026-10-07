import "server-only";
import { z } from "zod";
import { mapTaxRates, parseFeedMeta, parseTenderMeta } from "@/lib/device/meta";
import {
  deviceFeedMeta,
  deviceFeedTable,
  deviceTenderTypes,
  type FeedTable,
} from "@/lib/device/service";
import { feedSchema, type Feed } from "./feed";

const PAGE = 1000;

const row = z.record(z.string(), z.any());

/** Reads every row of one catalogue table for the till's shop, a page at a time (keyed by id). */
async function all(tokenHash: string, table: FeedTable, since: Date | null) {
  const rows: z.infer<typeof row>[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await deviceFeedTable(tokenHash, table, since, after, PAGE);
    if (!page) throw new Error("Could not load the catalogue");
    const parsed = z.array(row).parse(page);
    rows.push(...parsed);
    if (parsed.length < PAGE) return rows;
    after = String(parsed[parsed.length - 1]!.id);
  }
}

/**
 * The catalogue as a paired till needs it. Products and variants are never deleted (archived), so
 * `since` works as "updated since"; archived rows are sent so the device can drop them. The small
 * tables (categories, modifiers) are sent whole every time because rows can be deleted. Everything
 * is read through ops.device_* with the till's token hash, so the shop is the token's shop and the
 * till needs no user session. No cost prices.
 */
export async function getCatalogFeed(
  tokenHash: string,
  since: string | null,
): Promise<Feed | null> {
  // Taken before the reads and backed off a minute, so a transaction that commits while we read
  // is picked up next time. The overlap is harmless: the device upserts by id.
  const cursor = new Date(Date.now() - 60_000).toISOString();
  const sinceDate = since ? new Date(since) : null;

  const rawMeta = await deviceFeedMeta(tokenHash);
  if (!rawMeta) return null;
  const meta = parseFeedMeta(rawMeta);
  const rawTypes = await deviceTenderTypes(tokenHash);
  const tenderTypes = rawTypes ? parseTenderMeta(rawTypes).types.filter((t) => !t.archived) : [];

  const [categories, products, variants, groups, mods, pgroups] = await Promise.all([
    all(tokenHash, "categories", null),
    all(tokenHash, "products", sinceDate),
    all(tokenHash, "variants", sinceDate),
    all(tokenHash, "modifier_groups", null),
    all(tokenHash, "modifiers", null),
    all(tokenHash, "product_modifier_groups", null),
  ]);

  return feedSchema.parse({
    cursor,
    full: since === null,
    org: {
      businessType: meta.org.business_type,
      timezone: meta.location.timezone,
      country: "IE",
      name: meta.org.name,
      legalName: meta.org.legal_name,
      vatNumber: meta.org.vat_number,
      address: meta.location.address,
      eircode: meta.location.eircode,
      receiptFooter: meta.location.receipt_footer,
      discountOverrideBp: meta.org.discount_override_bp,
    },
    staff: meta.staff.map((s) => ({
      userId: s.user_id,
      displayName: s.display_name,
      role: s.role,
      pinHash: s.pin_hash,
    })),
    tenderTypes: tenderTypes.map((t) => ({
      id: t.id,
      method: t.method,
      label: t.label,
      sort: t.sort,
    })),
    serverTime: new Date().toISOString(),
    registers: [
      { id: meta.register.id, name: meta.register.name, lastSeq: meta.register.last_seq },
    ],
    taxRates: mapTaxRates(meta.tax_rates),
    categories: categories
      .map((c) => ({ id: c.id, name: c.name, colour: c.colour, sort: c.sort }))
      .sort((a, b) => a.sort - b.sort || String(a.id).localeCompare(String(b.id))),
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      categoryId: p.category_id,
      taxCategory: p.tax_category,
      takeawayTaxCategory: p.takeaway_tax_category,
      archived: p.archived_at !== null,
    })),
    variants: variants.map((v) => ({
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
    modifierGroups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      min: g.min_choices,
      max: g.max_choices,
      sort: g.sort,
    })),
    modifiers: mods.map((m) => ({
      id: m.id,
      groupId: m.group_id,
      name: m.name,
      priceDeltaCents: m.price_delta_cents,
      sort: m.sort,
    })),
    productGroups: pgroups.map((g) => ({
      id: g.id,
      productId: g.product_id,
      groupId: g.group_id,
      sort: g.sort,
    })),
  });
}

export type { Feed };
