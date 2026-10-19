import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/auth/session-proxy";
import { superadminIpAllowed } from "@/lib/superadmin/ip";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // The superadmin console is only reachable from the allowlisted IPs. Fail closed: with no
  // SUPERADMIN_IP_ALLOWLIST nobody gets in. A plain 404, the same as any page that does not exist,
  // and before any session or database work. The same 404 page Next shows for an unknown route (a
  // rewrite to a path that does not exist), so the console's existence cannot be told apart. This is
  // a first lock only: every page and every server action calls requireSuperadmin(), which checks
  // the IP again (a server action can be POSTed to any path with a Next-Action header).
  if (
    (pathname === "/superadmin" || pathname.startsWith("/superadmin/")) &&
    !superadminIpAllowed(request.headers)
  ) {
    return NextResponse.rewrite(new URL("/__no-such-page", request.url), { status: 404 });
  }
  return updateSession(request);
}

export const config = {
  // Everything except Next internals and static files.
  matcher: [
    "/((?!api/health|api/log-error|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
