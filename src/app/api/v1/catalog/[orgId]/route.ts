import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateDevice } from "@/lib/device/auth";
import { getCatalogFeed } from "@/lib/register/feed-server";

export const dynamic = "force-dynamic";

const since = z.iso.datetime().nullable();

/**
 * The register's catalogue pull: everything, or only what changed since `?since=` (the cursor
 * returned last time). Only a paired till may read it, by its device token; the shop is the
 * token's shop (`orgId` in the URL is checked against it, never trusted).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string }> },
) {
  const { orgId } = await params;
  // A status, not a redirect: the device must tell "unpaired" from "offline".
  const device = await authenticateDevice(z.uuid().safeParse(orgId).success ? orgId : "");
  if (!device.ok) return Response.json({ error: "not allowed" }, { status: device.status });
  const parsed = since.safeParse(request.nextUrl.searchParams.get("since"));
  if (!parsed.success) return Response.json({ error: "bad since" }, { status: 400 });
  const feed = await getCatalogFeed(device.tokenHash, parsed.data);
  if (!feed) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(feed, { headers: { "Cache-Control": "no-store" } });
}
