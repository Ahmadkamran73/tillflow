import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateDevice } from "@/lib/device/auth";
import { reportError } from "@/lib/errors";
import { deviceFindSale } from "@/lib/device/service";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";
import { saleDetails } from "@/lib/sync/refund-detail";

export const dynamic = "force-dynamic";

const limiter = createMemoryLimiter(30, 60_000);

const query = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("id"), id: z.uuid() }),
  z.strictObject({
    by: z.literal("receipt"),
    register_id: z.uuid(),
    seq: z.coerce.number().int().min(1).max(99_999_999),
  }),
  z.strictObject({ by: z.literal("serial"), serial: z.string().trim().min(3).max(64) }),
]);

/**
 * GET /api/v1/register/sales/lookup?orgId=&by=id|receipt|serial&...: finds past sales of this
 * shop to refund when the till does not hold them itself (another till's sale, an older one, or by
 * serial / IMEI). Paired device only; the shop comes from the token. Returns each sale's lines,
 * payments and what has been refunded already: no customer or invoice data. At most 5 sales.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const orgId = z.uuid().safeParse(params.get("orgId"));
  if (!orgId.success) return Response.json({ error: "bad org" }, { status: 400 });
  const viewer = z.uuid().safeParse(params.get("as"));
  if (!viewer.success) return Response.json({ error: "bad query" }, { status: 400 });
  const parsed = query.safeParse(
    Object.fromEntries([...params].filter(([k]) => k !== "orgId" && k !== "as")),
  );
  if (!parsed.success) return Response.json({ error: "bad query" }, { status: 400 });

  const auth = await authenticateDevice(orgId.data);
  if (!auth.ok) return Response.json({ error: "not allowed" }, { status: auth.status });
  if (!limiter.take(auth.registerId)) {
    return Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": "30" } });
  }
  try {
    const found = await deviceFindSale(auth.tokenHash, { ...parsed.data, viewer: viewer.data });
    if (found === null) return Response.json({ error: "not allowed" }, { status: 401 });
    return Response.json(
      { sales: saleDetails.parse(found) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    await reportError(e, { source: "server", route: "/api/v1/register/sales/lookup" });
    return Response.json({ error: "try again" }, { status: 503 });
  }
}
