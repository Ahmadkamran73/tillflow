import type { NextRequest } from "next/server";
import { z } from "zod";
import { reportError } from "@/lib/errors";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";
import { authenticateRegister } from "@/lib/sync/auth";
import { MAX_BODY_BYTES } from "@/lib/sync/protocol";
import { refundBatch } from "@/lib/sync/refund-protocol";
import { syncRefundsFromDevice } from "@/lib/sync/server";

export const dynamic = "force-dynamic";

const limiter = createMemoryLimiter(120, 60_000);

/**
 * POST /api/v1/sync/refunds?orgId=<uuid>: the register's queued refunds, voids and exchange
 * returns. Same shape as the sales route: authenticates the paired device by its token, validates
 * each refund on its own, recomputes every amount from the original sale's stored lines and records
 * it once (idempotent on the refund id). `retry` means the original sale has not arrived yet.
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
  const batch = refundBatch.safeParse(json);
  if (!batch.success) return Response.json({ error: "bad batch" }, { status: 400 });

  const auth = await authenticateRegister(orgId.data, batch.data.registerId);
  if (!auth.ok) return Response.json({ error: "not allowed" }, { status: auth.status });
  if (!limiter.take(auth.registerId)) {
    return Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": "30" } });
  }

  try {
    const results = await syncRefundsFromDevice(batch.data.refunds, auth);
    return Response.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    await reportError(e, { source: "server", route: "/api/v1/sync/refunds" });
    return Response.json({ error: "try again" }, { status: 503 });
  }
}
