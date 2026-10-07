import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PREFIXES = ["/o", "/onboarding", "/start", "/mfa", "/reset-password"];

function isProtected(pathname: string) {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Runs in proxy.ts on every page request: refreshes the Supabase session cookies and does an
 * optimistic "is there a session?" redirect for back-office paths. It is NOT the authorisation
 * check. Roles, org membership and MFA are enforced by requireRole()/requireBackOffice() where
 * the data is read.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) throw new Error("Supabase environment variables are not set");

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(toSet) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  const { data } = await supabase.auth.getClaims();

  const { pathname, search } = request.nextUrl;
  // Already signed in: the home page and log-in form go straight to the dashboard instead of
  // asking for a password again. Skipped when `next` or `error` is present, so a session that
  // is really dead (revoked) cannot bounce between /o and /login.
  if (
    data?.claims &&
    (pathname === "/" || pathname === "/login") &&
    !request.nextUrl.searchParams.has("next") &&
    !request.nextUrl.searchParams.has("error")
  ) {
    const base = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    const redirect = NextResponse.redirect(new URL("/o", base));
    for (const c of response.cookies.getAll()) redirect.cookies.set(c);
    return redirect;
  }
  if (!data?.claims && isProtected(pathname)) {
    // Not request.nextUrl: behind Hostinger's proxy its origin is the internal 0.0.0.0:3000.
    const base = process.env.NEXT_PUBLIC_APP_URL || request.nextUrl.origin;
    const next = encodeURIComponent(pathname + search);
    return NextResponse.redirect(new URL(`/login?next=${next}`, base));
  }
  return response;
}
