import "server-only";
import { createSupabaseServerClient } from "@/lib/auth";
import { getLocation, getTaxRates } from "@/lib/catalog";
import { parseSyncMeta, parseTenderMeta } from "@/lib/device/meta";
import {
  deviceSaleCatalogAsOf,
  deviceSalesKnown,
  deviceSyncMeta,
  deviceTenderTypes,
  recordSale,
  recordSyncRejection,
} from "@/lib/ops/db";
import { presets } from "@/config/business-type-presets";
import { getOrganisation } from "@/lib/org";
import { loadRowsAsOf, priceRows } from "@/lib/register/price-server";
import type { RateRow } from "@/lib/money";
import { rowsFromAsOf } from "./as-of";
import { processBatch, type SyncCtx, type SyncDeps } from "./process";
import type { SyncResult, SyncSale } from "./protocol";

type Shop = { timezone: string; taxRates: RateRow[] };

/** Wires the pure processor to a source of catalogue data; writes always go through ops.* only. */
function run(
  rawSales: unknown[],
  ctx: SyncCtx,
  shop: Shop,
  source: Pick<SyncDeps, "existingIds"> & {
    rowsAsOf: (sale: SyncSale, at: Date) => ReturnType<typeof loadRowsAsOf>;
    /** The till's token hash; null only for the back office's trusted Try again. */
    tokenHash: string | null;
  },
): Promise<SyncResult[]> {
  const deps: SyncDeps = {
    now: () => new Date(),
    existingIds: source.existingIds,
    async priceAt(sale, at) {
      return priceRows(sale, await source.rowsAsOf(sale, at), shop.taxRates, shop.timezone);
    },
    recordSale: (payload) => recordSale(payload, source.tokenHash),
    recordRejection: recordSyncRejection,
  };
  return processBatch(rawSales, ctx, deps);
}

/**
 * Sales from a paired till. The shop and the till come from its device token (`tokenHash`), and all
 * reads go through ops.device_* functions scoped to that token: the till has no user session.
 */
export async function syncSalesFromDevice(
  rawSales: unknown[],
  device: { tokenHash: string; orgId: string; registerId: string },
): Promise<SyncResult[]> {
  // An empty batch is the till's heartbeat: authenticating it already recorded "last seen".
  if (rawSales.length === 0) return [];
  const raw = await deviceSyncMeta(device.tokenHash);
  if (!raw) throw new Error("Device is not paired");
  const meta = parseSyncMeta(raw);
  const rawTypes = await deviceTenderTypes(device.tokenHash);
  if (!rawTypes) throw new Error("Device is not paired");
  const tenderMeta = parseTenderMeta(rawTypes);

  return run(
    rawSales,
    {
      orgId: device.orgId,
      registerId: device.registerId,
      discountOverrideBp: meta.discountOverrideBp,
      tenderTypes: tenderMeta.types,
      tipsAllowed: presets[tenderMeta.businessType].register.tips,
      shopRoundCash: presets[tenderMeta.businessType].register.cashRounding5c,
    },
    meta,
    {
      tokenHash: device.tokenHash,
      async existingIds(ids) {
        return new Set(await deviceSalesKnown(device.tokenHash, ids));
      },
      async rowsAsOf(sale, at) {
        const data = await deviceSaleCatalogAsOf(
          device.tokenHash,
          [...new Set(sale.lines.map((l) => l.variantId))],
          [...new Set(sale.lines.flatMap((l) => l.modifierIds))],
          at,
        );
        if (!data) throw new Error("Could not load the catalogue");
        return rowsFromAsOf(data);
      },
    },
  );
}

/**
 * The back office re-running a rejected sale ("Try again"): reads as the signed-in manager (RLS), in
 * the same server check a till's sale goes through. Whoever presses it may approve a discount.
 */
export async function syncSalesFromSession(
  rawSales: unknown[],
  ctx: { orgId: string; registerId: string; approverUserId?: string },
): Promise<SyncResult[]> {
  const [location, taxRates, org] = await Promise.all([
    getLocation(ctx.orgId),
    getTaxRates(),
    getOrganisation(ctx.orgId),
  ]);
  if (!location || !org) throw new Error("Shop has no location");
  const supabase = await createSupabaseServerClient();
  // RLS: a manager (who presses Try again) reads the payment types of their shop.
  const { data: tenderTypes, error: tenderError } = await supabase
    .from("tender_types")
    .select("id, method")
    .eq("org_id", ctx.orgId)
    .eq("location_id", location.id);
  if (tenderError) throw new Error("Could not load payment types");

  return run(
    rawSales,
    {
      ...ctx,
      discountOverrideBp: org.discountOverrideBp,
      tenderTypes: (tenderTypes ?? []).map((t) => ({
        id: t.id as string,
        method: t.method as string,
      })),
      tipsAllowed: presets[org.businessType].register.tips,
      shopRoundCash: presets[org.businessType].register.cashRounding5c,
    },
    { timezone: location.timezone, taxRates },
    {
      tokenHash: null,
      async existingIds(ids) {
        // Not a plain select: a cashier's RLS hides other cashiers' sales, but a replay must still be
        // recognised as a duplicate.
        const { data, error } = await supabase.rpc("sales_known", { p_org: ctx.orgId, p_ids: ids });
        if (error) throw new Error("Could not check existing sales");
        return new Set((data ?? []) as string[]);
      },
      rowsAsOf: (sale, at) => loadRowsAsOf(ctx.orgId, sale, at),
    },
  );
}
