import "server-only";
import { authorizeApi, createSupabaseServerClient, type ApiAuth } from "@/lib/auth";

export type RegisterAuth =
  | { ok: true; userId: string; orgId: string; registerId: string }
  | { ok: false; status: 401 | 403 | 404 };

/**
 * Who is syncing, and for which till. Until device pairing (step 1.7) this is the signed-in
 * member's session plus a register id that must belong to the org. Step 1.7 replaces the body with
 * a device-token check; nothing that calls this changes.
 */
export async function authenticateRegister(
  orgId: string,
  registerId: string,
): Promise<RegisterAuth> {
  const auth: ApiAuth = await authorizeApi(["owner", "manager", "cashier"], orgId);
  if (!auth.ok) return auth;
  const supabase = await createSupabaseServerClient();
  // RLS scopes this to the caller's shops; the org filter is belt and braces.
  const { data } = await supabase
    .from("registers")
    .select("id")
    .eq("id", registerId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!data) return { ok: false, status: 404 };
  return { ok: true, userId: auth.user.id, orgId, registerId };
}
