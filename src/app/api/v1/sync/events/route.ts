import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateDevice } from "@/lib/device/auth";
import { recordRegisterEvents } from "@/lib/device/service";
import { reportError } from "@/lib/errors";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";

export const dynamic = "force-dynamic";

const limiter = createMemoryLimiter(60, 60_000);
const NO_STORE = { "Cache-Control": "no-store" };
const MAX_EVENTS = 25;

/** What the till queued when a manager approved something outside a sale (drawer open, refund). */
const event = z.strictObject({
  id: z.uuid(),
  kind: z.enum(["no_sale", "refund_override", "void_item"]),
  at: z.iso.datetime(),
  cashierUserId: z.uuid(),
  /** The server's proof of a manager PIN (register_approvals). Only the server can make one. */
  approvalId: z.uuid().optional(),
  /** Offline there is no proof: the manager the till says approved it. Logged as a claim, never as fact. */
  claimedApprover: z.uuid().optional(),
  /** Short, non-personal facts only (a reason code, a sale id). Never names or card data. */
  detail: z
    .record(z.string().max(40), z.union([z.string().max(100), z.number(), z.boolean()]))
    .default({}),
});
const body = z.strictObject({ events: z.array(z.unknown()).max(MAX_EVENTS) });

export type EventResult = { id: string; status: "recorded" | "rejected" };

/**
 * POST /api/v1/sync/events: the till's events outbox. Each event is checked on its own (the cashier
 * must be staff of the shop; an approval id must be a real, unspent PIN approval for this till)
 * and written to the audit log under the event's own id, so a replay changes nothing. Without an
 * approval id the row says "unverified_offline" and names no approver. A refused event is reported back as
 * rejected and is not retried; one bad event never blocks the others.
 */
export async function POST(request: NextRequest) {
  const device = await authenticateDevice();
  if (!device.ok) return Response.json({ error: "not paired" }, { status: 401, headers: NO_STORE });
  if (!limiter.take(device.registerId)) {
    return Response.json(
      { error: "slow down" },
      { status: 429, headers: { ...NO_STORE, "Retry-After": "30" } },
    );
  }

  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > 64 * 1024) {
    return Response.json({ error: "bad size" }, { status: 413, headers: NO_STORE });
  }
  let json: unknown;
  try {
    json = JSON.parse(await request.text());
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }
  const parsed = body.safeParse(json);
  if (!parsed.success)
    return Response.json({ error: "bad batch" }, { status: 400, headers: NO_STORE });

  try {
    const results: EventResult[] = [];
    for (const raw of parsed.data.events) {
      const e = event.safeParse(raw);
      const id = z.uuid().safeParse((raw as { id?: unknown } | null)?.id);
      if (!e.success) {
        results.push({ id: id.success ? id.data : "", status: "rejected" });
        continue;
      }
      try {
        await recordRegisterEvents(device.tokenHash, [
          {
            id: e.data.id,
            kind: e.data.kind,
            at: e.data.at,
            cashier_user_id: e.data.cashierUserId,
            approval_id: e.data.approvalId ?? null,
            claimed_approver: e.data.claimedApprover ?? null,
            detail: e.data.detail,
          },
        ]);
        results.push({ id: e.data.id, status: "recorded" });
      } catch (err) {
        // 42501 = the cashier or approver is not (or is no longer) the right kind of staff here;
        // 22xxx = a value the database refuses. Both will fail again: report, do not retry.
        const code = (err as { code?: string }).code ?? "";
        if (code !== "42501" && !code.startsWith("22")) throw err;
        await reportError(new Error("register event rejected"), {
          source: "server",
          route: "/api/v1/sync/events",
          context: { kind: e.data.kind, code },
        });
        results.push({ id: e.data.id, status: "rejected" });
      }
    }
    return Response.json({ results }, { headers: NO_STORE });
  } catch (err) {
    await reportError(err, { source: "server", route: "/api/v1/sync/events" });
    return Response.json({ error: "try again" }, { status: 503, headers: NO_STORE });
  }
}
