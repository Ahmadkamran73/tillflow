import { NextResponse, type NextRequest } from "next/server";
import { appUrl, isGoogleAuthEnabled } from "@/lib/auth/config";
import { safeNext } from "@/lib/auth/redirect";
import { callbackParams } from "@/lib/auth/schemas";
import { createSupabaseServerClient } from "@/lib/auth/server";

/**
 * Landing point for every emailed link and for the Google redirect:
 *  - `token_hash` + `type` (confirm email, magic link, password recovery), or
 *  - `code` (OAuth PKCE).
 * Redirects are built from NEXT_PUBLIC_APP_URL, never from the request: behind Hostinger's proxy
 * the request URL is the internal 0.0.0.0:3000.
 * It only creates the session; roles, org provisioning and MFA are applied by the page it
 * forwards to (requireBackOffice / requireRole).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const fail = (reason: string) =>
    NextResponse.redirect(new URL(`/login?error=${reason}`, appUrl()));

  const parsed = callbackParams.safeParse({
    code: searchParams.get("code") ?? undefined,
    token_hash: searchParams.get("token_hash") ?? undefined,
    type: searchParams.get("type") ?? undefined,
  });
  if (!parsed.success) return fail("callback");
  const { code, token_hash, type } = parsed.data;
  const next = safeNext(searchParams.get("next"));

  const supabase = await createSupabaseServerClient();
  if (token_hash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash, type });
    if (error) return fail("link_expired");
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return fail("callback");
  } else {
    return fail("callback");
  }

  // Google is for owners and managers. Judge by how THIS session was created (the amr claim), not
  // by a query parameter the caller controls. A person who only has cashier access is refused.
  const { data: claims } = await supabase.auth.getClaims();
  const viaOAuth =
    claims?.claims.amr?.some((a) => (typeof a === "string" ? a : a.method) === "oauth") ?? false;
  if (viaOAuth) {
    const userId = claims?.claims.sub;
    const { data: rows } = userId
      ? await supabase.from("memberships").select("role").eq("user_id", userId)
      : { data: [] };
    const roles = (rows ?? []).map((r) => r.role);
    const cashierOnly = roles.length > 0 && !roles.some((r) => r === "owner" || r === "manager");
    if (!isGoogleAuthEnabled() || cashierOnly) {
      await supabase.auth.signOut();
      return fail("google_not_allowed");
    }
  }

  return NextResponse.redirect(new URL(next, appUrl()));
}
