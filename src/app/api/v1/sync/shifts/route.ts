import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateDevice } from "@/lib/device/auth";
import { reportError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs";
import { recordShiftEvent } from "@/lib/device/service";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";

export const dynamic = "force-dynamic";

const limiter = createMemoryLimiter(60, 60_000);
const NO_STORE = { "Cache-Control": "no-store" };
const MAX_EVENTS = 25;

const cents = z.int().min(0).max(100_000_000);
const base = { id: z.uuid(), cashierUserId: z.uuid(), at: z.iso.datetime() };

/** What the till queued about a shift. The shop and till come from the device token, never from here. */
const open = z.strictObject({
  kind: z.literal("open"),
  ...base,
  floatCents: z.int().min(0).max(10_000_000),
});
const cash = z.strictObject({
  kind: z.literal("cash"),
  ...base,
  shiftId: z.uuid(),
  movement: z.enum(["in", "out"]),
  amountCents: z.int().min(1).max(10_000_000),
  note: z.string().trim().min(1).max(200),
});
const close = z.strictObject({
  kind: z.literal("close"),
  ...base,
  shiftId: z.uuid(),
  countedCents: cents,
  /** What the till printed; the server works out its own and flags a difference. */
  expectedCents: z.int().min(-100_000_000).max(100_000_000),
  saleCount: z.int().min(0).max(1_000_000),
  refundCount: z.int().min(0).max(1_000_000),
  /** Sales/refunds of the shift the server refused: the over/short is then flagged. */
  rejectedCount: z.int().min(0).max(1_000_000).default(0),
});
const event = z.discriminatedUnion("kind", [open, cash, close]);
const body = z.strictObject({ events: z.array(z.unknown()).max(MAX_EVENTS) });

export type ShiftEventOutcome = { id: string; status: "recorded" | "duplicate" | "rejected" };

/**
 * POST /api/v1/sync/shifts: the till's shift outbox (open, cash in/out, close), oldest first. Each
 * event is checked on its own; a refused one is reported back as rejected and not retried, and never
 * blocks the others. A NEW close queues the emailed Z.
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
    const results: ShiftEventOutcome[] = [];
    for (const raw of parsed.data.events) {
      const e = event.safeParse(raw);
      const id = z.uuid().safeParse((raw as { id?: unknown } | null)?.id);
      if (!e.success) {
        results.push({ id: id.success ? id.data : "", status: "rejected" });
        continue;
      }
      const d = e.data;
      try {
        const status = await recordShiftEvent(device.tokenHash, {
          kind: d.kind,
          id: d.id,
          org_id: device.orgId,
          register_id: device.registerId,
          user_id: d.cashierUserId,
          at: d.at,
          ...(d.kind === "open" ? { float_cents: d.floatCents } : {}),
          ...(d.kind === "cash"
            ? {
                shift_id: d.shiftId,
                movement: d.movement,
                amount_cents: d.amountCents,
                note: d.note,
              }
            : {}),
          ...(d.kind === "close"
            ? {
                shift_id: d.shiftId,
                counted_cents: d.countedCents,
                client_expected_cents: d.expectedCents,
                sale_count: d.saleCount,
                refund_count: d.refundCount,
                rejected_count: d.rejectedCount,
              }
            : {}),
        });
        if (d.kind === "close" && status === "recorded") {
          // A failed queueing must not undo or block the close: the Z can be re-sent from the back office later.
          await enqueue("shift-z-email", { shift_id: d.shiftId }).catch((err) =>
            reportError(err, { source: "server", route: "/api/v1/sync/shifts" }),
          );
        }
        results.push({ id: d.id, status });
      } catch (err) {
        // 42501 not staff / not this till; 22xxx and 23xxx a value the database refuses; TF001 a shift
        // is already open. All fail again: report, do not retry.
        const code = (err as { code?: string }).code ?? "";
        if (
          code !== "42501" &&
          code !== "TF001" &&
          !code.startsWith("22") &&
          !code.startsWith("23")
        )
          throw err;
        await reportError(new Error("shift event rejected"), {
          source: "server",
          route: "/api/v1/sync/shifts",
          context: { kind: d.kind, code },
        });
        results.push({ id: d.id, status: "rejected" });
      }
    }
    return Response.json({ results }, { headers: NO_STORE });
  } catch (err) {
    await reportError(err, { source: "server", route: "/api/v1/sync/shifts" });
    return Response.json({ error: "try again" }, { status: 503, headers: NO_STORE });
  }
}
