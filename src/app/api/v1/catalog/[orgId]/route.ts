import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi } from "@/lib/auth";
import { getCatalogFeed } from "@/lib/register/feed-server";

export const dynamic = "force-dynamic";

const since = z.iso.datetime().nullable();

/**
 * The register's catalogue pull: everything, or only what changed since `?since=` (the cursor
 * returned last time). Any member of the shop may read it; RLS scopes the rows.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // A status, not a redirect: the device must tell "signed out" from "offline".
  const auth = await authorizeApi(["owner", "manager", "cashier"], orgId);
  if (!auth.ok) return Response.json({ error: "not allowed" }, { status: auth.status });
  const parsed = since.safeParse(request.nextUrl.searchParams.get("since"));
  if (!parsed.success) return Response.json({ error: "bad since" }, { status: 400 });
  const feed = await getCatalogFeed(orgId, parsed.data);
  if (!feed) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(feed, { headers: { "Cache-Control": "no-store" } });
}
