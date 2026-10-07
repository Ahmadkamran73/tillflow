import "server-only";
import { createSupabaseServerClient } from "@/lib/auth";

const DAY_MS = 24 * 3_600_000;

/**
 * What a manager should look at on the dashboard: sales the server refused (open items on
 * "Needs attention"), saved sales flagged for review, and paired tills that have not reached the
 * server for a day. Reads as the
 * caller, so RLS applies (managers and owners only get rows back).
 */
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

/** How far back the review list looks. */
const REVIEW_WINDOW_DAYS = 90;

/**
 * Synced sales the server saved but flagged (VAT differs from the till's, or priced at an older,
 * cheaper catalogue) that no manager has marked reviewed yet. Sales are never edited: a review is
 * a `sale.reviewed` audit row, so this joins the two in code.
 */
export async function getSalesToReview(orgId: string, limit = 100): Promise<SaleToReview[]> {
  const supabase = await createSupabaseServerClient();
  const since = new Date(Date.now() - REVIEW_WINDOW_DAYS * DAY_MS).toISOString();
  const { data, error } = await supabase
    .from("sales")
    .select(
      "id, register_id, receipt_seq, completed_at, review_flags, vat_cents, client_vat_cents, amount_due_cents",
    )
    .eq("org_id", orgId)
    .neq("review_flags", "{}")
    .gte("received_at", since)
    .order("completed_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Could not load sales to review");
  const rows = data ?? [];
  if (rows.length === 0) return [];
  const reviewed = await supabase
    .from("audit_log")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("action", "sale.reviewed")
    .in(
      "entity_id",
      rows.map((r) => r.id as string),
    );
  if (reviewed.error) throw new Error("Could not load sales to review");
  const done = new Set((reviewed.data ?? []).map((r) => r.entity_id as string));
  return rows
    .filter((r) => !done.has(r.id as string))
    .map((r) => ({
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
