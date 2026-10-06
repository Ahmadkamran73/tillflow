import type { NextRequest } from "next/server";
import { z } from "zod";
import { reportError } from "@/lib/errors";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";
import { authenticateRegister } from "@/lib/sync/auth";
import { MAX_BODY_BYTES, syncBatch } from "@/lib/sync/protocol";
import { syncSales } from "@/lib/sync/server";

export const dynamic = "force-dynamic";

// Per process (a database write per request is not worth it here); generous for a busy till.
const limiter = createMemoryLimiter(120, 60_000);

/**
 * POST /api/v1/sync/sales?orgId=<uuid>: the register's outbox. Authenticates, validates each sale,
 * has the server re-price it, and records it once (idempotent on the sale id). An empty batch is a
 * heartbeat. Answers 2xx with a result per sale (created | duplicate | rejected); anything else
 * means "nothing was lost, try again".
 */
export async function POST(request: NextRequest) {
  const orgId = z.uuid().safeParse(request.nextUrl.searchParams.get("orgId"));
  if (!orgId.success) return Response.json({ error: "bad org" }, { status: 400 });

  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > MAX_BODY_BYTES) {
    return Response.json({ error: "bad size" }, { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return Response.json({ error: "bad size" }, { status: 413 });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }
  const batch = syncBatch.safeParse(json);
  if (!batch.success) return Response.json({ error: "bad batch" }, { status: 400 });

  const auth = await authenticateRegister(orgId.data, batch.data.registerId);
  if (!auth.ok) return Response.json({ error: "not allowed" }, { status: auth.status });
  if (!limiter.take(auth.userId)) {
    return Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": "30" } });
  }

  try {
    const results = await syncSales(batch.data.sales, auth);
    return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    await reportError(e, { source: "server", route: "/api/v1/sync/sales" });
    return Response.json({ error: "try again" }, { status: 503 });
  }
}
