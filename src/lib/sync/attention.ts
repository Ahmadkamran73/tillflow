import "server-only";
import { createSupabaseServerClient } from "@/lib/auth";

const DAY_MS = 24 * 3_600_000;

/**
 * What a manager should look at on the dashboard: sales the server refused (open items on
 * "Needs attention") and paired tills that have not reached the server for a day. Reads as the
 * caller, so RLS applies (managers and owners only get rows back).
 */
export async function getAttention(orgId: string): Promise<{ open: number; staleTills: string[] }> {
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
      .lt("last_seen_at", dayAgo),
  ]);
  if (open.error || stale.error) throw new Error("Could not load sales needing attention");
  return { open: open.count ?? 0, staleTills: (stale.data ?? []).map((r) => r.name as string) };
}
