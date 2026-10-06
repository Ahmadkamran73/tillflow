import "server-only";
import { createSupabaseServerClient } from "@/lib/auth";
import { getLocation, getTaxRates } from "@/lib/catalog";
import { recordSale, recordSyncRejection, touchRegister } from "@/lib/ops/db";
import { loadRowsAsOf, priceRows } from "@/lib/register/price-server";
import { processBatch, type SyncCtx, type SyncDeps } from "./process";
import type { SyncResult } from "./protocol";

/** Wires the pure processor to the database: reads as the caller (RLS), writes via ops.* only. */
export async function syncSales(rawSales: unknown[], ctx: SyncCtx): Promise<SyncResult[]> {
  if (rawSales.length === 0) {
    await touchRegister(ctx.orgId, ctx.registerId, ctx.userId); // heartbeat: the till is alive
    return [];
  }
  const [location, taxRates] = await Promise.all([getLocation(ctx.orgId), getTaxRates()]);
  if (!location) throw new Error("Shop has no location");
  const supabase = await createSupabaseServerClient();

  const deps: SyncDeps = {
    now: () => new Date(),
    async existingIds(ids) {
      // Not a plain select: a cashier's RLS hides other cashiers' sales, but a replay must still be
      // recognised as a duplicate.
      const { data, error } = await supabase.rpc("sales_known", { p_org: ctx.orgId, p_ids: ids });
      if (error) throw new Error("Could not check existing sales");
      return new Set((data ?? []) as string[]);
    },
    async priceAt(sale, at) {
      const rows = await loadRowsAsOf(ctx.orgId, sale, at);
      return priceRows(sale, rows, taxRates, location.timezone);
    },
    recordSale,
    recordRejection: recordSyncRejection,
  };
  return processBatch(rawSales, ctx, deps);
}
