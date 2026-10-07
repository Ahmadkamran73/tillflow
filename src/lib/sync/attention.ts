import "server-only";
import { createSupabaseServerClient } from "@/lib/auth";

const DAY_MS = 24 * 3_600_000;

export type SaleToReview = {
  id: string;
  registerId: string;
  receiptSeq: number;
  completedAt: string;
  flags: string[];
  vatCents: number;
  clientVatCents: number | null;
  amountDueCents: number;
};

/**
 * Synced sales the server saved but flagged (VAT differs from the till's, or priced at an older,
 * cheaper catalogue) that no manager has marked reviewed yet, newest first. Sales are never edited:
 * a review is a `sale.reviewed` audit row. The database leaves reviewed sales out before the limit
 * (public.sales_to_review), so no number of reviewed sales can hide an unreviewed one.
 */
export async function getSalesToReview(orgId: string, limit = 100): Promise<SaleToReview[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("sales_to_review", { p_org: orgId, p_limit: limit });
  if (error) throw new Error("Could not load sales to review");
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    registerId: r.register_id as string,
    receiptSeq: r.receipt_seq as number,
    completedAt: r.completed_at as string,
    flags: r.review_flags as string[],
    vatCents: r.vat_cents as number,
    clientVatCents: (r.client_vat_cents as number | null) ?? null,
    amountDueCents: r.amount_due_cents as number,
  }));
}

/**
 * What a manager should look at on the dashboard: sales the server refused (open items on
 * "Needs attention"), saved sales flagged for review, and paired tills that have not reached the
 * server for a day. Reads as the caller, so RLS applies (managers and owners only get rows back).
 */
export async function getAttention(
  orgId: string,
): Promise<{ open: number; staleTills: string[]; toReview: number }> {
  const supabase = await createSupabaseServerClient();
  const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
  const [open, stale] = await Promise.all([
    supabase
      .from("sync_rejections")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "open"),
    supabase
      .from("registers")
      .select("name")
      .eq("org_id", orgId)
      .not("paired_at", "is", null)
      .or(`last_seen_at.is.null,last_seen_at.lt.${dayAgo}`),
  ]);
  if (open.error || stale.error) throw new Error("Could not load sales needing attention");
  const toReview = (await getSalesToReview(orgId)).length;
  return {
    open: open.count ?? 0,
    staleTills: (stale.data ?? []).map((r) => r.name as string),
    toReview,
  };
}
