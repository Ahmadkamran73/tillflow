import type { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateDevice } from "@/lib/device/auth";
import { reportError } from "@/lib/errors";
import { recordTabEvent } from "@/lib/device/service";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";

export const dynamic = "force-dynamic";

const limiter = createMemoryLimiter(60, 60_000);
const NO_STORE = { "Cache-Control": "no-store" };
const MAX_EVENTS = 50;

const small = z.int().min(0).max(1000);
const name = z.string().trim().max(20);
/** What the till queued about a tab. The shop and till come from the device token, never from here. */
const event = z.strictObject({
  id: z.uuid(),
  tabId: z.uuid(),
  kind: z.enum(["open", "send", "fire", "transfer", "merge", "close", "void"]),
  cashierUserId: z.uuid(),
  at: z.iso.datetime(),
  detail: z
    .strictObject({
      table: name.optional(),
      from: name.optional(),
      to: name.optional(),
      covers: small.optional(),
      course: small.optional(),
      lines: small.optional(),
      parts: small.optional(),
      mergedTab: z.uuid().optional(),
    })
    .default({}),
});
const body = z.strictObject({ events: z.array(z.unknown()).max(MAX_EVENTS) });

export type TabEventOutcome = { id: string; status: "recorded" | "duplicate" | "rejected" };

/**
 * POST /api/v1/sync/tabs: the till's restaurant tab events, oldest first. Each is checked on its
 * own; a refused one is reported as rejected (not retried) and never blocks the others. A tab event
 * carries no money: the bill is the sales paid from the tab.
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
    const results: TabEventOutcome[] = [];
    for (const raw of parsed.data.events) {
      const e = event.safeParse(raw);
      const id = z.uuid().safeParse((raw as { id?: unknown } | null)?.id);
      if (!e.success) {
        results.push({ id: id.success ? id.data : "", status: "rejected" });
        continue;
      }
      const d = e.data;
      try {
        const status = await recordTabEvent(device.tokenHash, {
          id: d.id,
          tab_id: d.tabId,
          kind: d.kind,
          cashier_user_id: d.cashierUserId,
          at: d.at,
          detail: {
            ...d.detail,
            ...(d.detail.mergedTab ? { merged_tab: d.detail.mergedTab } : {}),
            mergedTab: undefined,
          },
        });
        results.push({ id: d.id, status });
      } catch (err) {
        // 42501 not staff; 22xxx / 23xxx a value the database refuses. All fail again: report, do not retry.
        const code = (err as { code?: string }).code ?? "";
        if (code !== "42501" && !code.startsWith("22") && !code.startsWith("23")) throw err;
        await reportError(new Error("tab event rejected"), {
          source: "server",
          route: "/api/v1/sync/tabs",
          context: { kind: d.kind, code },
        });
        results.push({ id: d.id, status: "rejected" });
      }
    }
    return Response.json({ results }, { headers: NO_STORE });
  } catch (err) {
    await reportError(err, { source: "server", route: "/api/v1/sync/tabs" });
    return Response.json({ error: "try again" }, { status: 503, headers: NO_STORE });
  }
}
