import { z } from "zod";
import type { LocalSale, RegisterDb } from "@/lib/register/db";
import { MAX_BATCH, syncResponse, type SyncSale } from "./protocol";

// The device side of docs/PLAN.md section 9. Runs in the page and in the service worker, so it
// takes everything it needs as arguments and touches only IndexedDB and `fetch`.
//
// Rules: oldest first; a row is marked synced only after the server said created/duplicate and is
// never deleted before then; a rejected sale is marked rejected and the queue moves on; any
// network or server failure stops the drain and backs off, losing nothing.

/** "signed-out" now means this till is no longer paired (revoked, or the device token is gone). */
export type DrainState = "idle" | "backoff" | "signed-out" | "locked";
export type DrainResult = { state: DrainState; sent: number };

type Backoff = { attempts: number; nextAt: number };

const BASE_MS = 2_000;
const CAP_MS = 5 * 60_000;
export const KEEP_SYNCED_MS = 30 * 86_400_000;

export const backoffDelay = (attempts: number, random: () => number = Math.random) =>
  Math.round(Math.min(CAP_MS, BASE_MS * 2 ** Math.max(0, attempts - 1)) * (0.5 + random() / 2));

export type DrainOptions = {
  fetchFn?: typeof fetch;
  now?: () => number;
  random?: () => number;
  /** Ignore the backoff timer (the network just came back, or a sale was just made). */
  force?: boolean;
};

async function withLock<T>(name: string, fn: () => Promise<T>, busy: T): Promise<T> {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks) return fn();
  return locks.request(name, { ifAvailable: true }, async (lock) => (lock ? fn() : busy));
}

/** Pending sales, oldest first (UUIDv7 ids sort by time). */
export const pendingSales = (db: RegisterDb) =>
  db.sales.where("syncState").equals("pending").sortBy("id");

/**
 * Stands in for the cashier of a sale queued before step 1.7 (nobody's PIN unlocked the till). The
 * server refuses it as "not staff of this shop" and a manager sees it under Needs attention.
 */
export const LEGACY_CASHIER = "00000000-0000-4000-8000-000000000000";

const toWire = (s: LocalSale): SyncSale => ({
  id: s.id,
  cashierUserId: s.cashierUserId ?? LEGACY_CASHIER,
  approvalId: s.approvalId,
  receiptSeq: s.receiptSeq,
  completedAt: s.completedAt,
  catalogAsOf: s.catalogAsOf,
  mode: s.cart.mode ?? "eat_in",
  lines: s.cart.lines.map((l) => ({
    variantId: l.variantId,
    qty: l.qty,
    modifierIds: l.modifiers.map((m) => m.id),
    serial: l.serial,
    discount: l.discount,
  })),
  basketDiscount: s.cart.discount,
  tenderedCents: s.tenderedCents,
  expectedDueCents: s.expectedDueCents,
  expectedVatCents: s.expectedVatCents,
});

async function fail(db: RegisterDb, opts: Required<Pick<DrainOptions, "now" | "random">>) {
  const prev = (await db.meta.get("syncBackoff"))?.value as Backoff | undefined;
  const attempts = (prev?.attempts ?? 0) + 1;
  await db.meta.put({
    key: "syncBackoff",
    value: { attempts, nextAt: opts.now() + backoffDelay(attempts, opts.random) } satisfies Backoff,
  });
}

/** The server answered: clear the backoff and note the contact time (for the 24-hour warning). */
const succeed = async (db: RegisterDb, now: number) => {
  await db.meta.delete("syncBackoff");
  await db.meta.put({ key: "lastContactAt", value: now });
};

/**
 * Sends pending sales until none are left or something fails. Only one drainer runs per shop at a
 * time (Web Locks); a second caller returns `locked`. Safe to call from anywhere, any time.
 */
export function drainOutbox(
  db: RegisterDb,
  orgId: string,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  return withLock<DrainResult>(
    `tillflow-sync-${orgId}`,
    async () => {
      let sent = 0;
      let batchSize = MAX_BATCH;
      for (;;) {
        const backoff = (await db.meta.get("syncBackoff"))?.value as Backoff | undefined;
        if (backoff && backoff.nextAt > now() && !options.force) return { state: "backoff", sent };
        options = { ...options, force: false };

        const pending = await pendingSales(db);
        if (pending.length === 0) {
          // Approvals the manager gave outside a sale (drawer opens) go after the sales.
          const events = await drainEvents(db, fetchFn, { now, random });
          if (events !== "ok") return { state: events, sent };
          await db.meta.delete("syncBackoff"); // nothing waiting, so nothing to back off from
          await prune(db, now());
          return { state: "idle", sent };
        }
        const registerId = pending[0]!.registerId;
        const batch = pending.filter((s) => s.registerId === registerId).slice(0, batchSize);

        let res: Response;
        try {
          res = await fetchFn(`/api/v1/sync/sales?orgId=${encodeURIComponent(orgId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            cache: "no-store",
            body: JSON.stringify({ registerId, sales: batch.map(toWire) }),
          });
        } catch {
          await fail(db, { now, random }); // offline, or the server could not be reached
          return { state: "backoff", sent };
        }

        if (res.status === 401 || res.status === 403) return { state: "signed-out", sent };
        if ((res.status === 400 || res.status === 413) && batch.length > 1) {
          batchSize = Math.max(1, Math.floor(batch.length / 2)); // too big: send fewer at once
          continue;
        }
        if (res.status === 400 || res.status === 413) {
          // One sale and still refused: the server never judged the sale (it answers per sale), so
          // this is the request itself. Keep the sale pending and try again later; marking it
          // rejected here would hide a sale the server has no record of.
          await fail(db, { now, random });
          return { state: "backoff", sent };
        }

        let results;
        try {
          if (!res.ok) throw new Error(String(res.status));
          results = syncResponse.parse(await res.json()).results;
        } catch {
          await fail(db, { now, random });
          return { state: "backoff", sent };
        }

        const byId = new Map(results.map((r) => [r.id, r]));
        let unresolved = 0;
        await db.transaction("rw", db.sales, async () => {
          for (const sale of batch) {
            const r = byId.get(sale.id);
            if (!r) {
              unresolved++;
              await db.sales.update(sale.id, { attempts: sale.attempts + 1 });
            } else if (r.status === "rejected") {
              await db.sales.update(sale.id, { syncState: "rejected", rejectReason: r.reason });
            } else {
              await db.sales.update(sale.id, { syncState: "synced", syncedAt: now() });
            }
          }
        });
        sent += batch.length - unresolved;
        if (unresolved > 0) {
          await fail(db, { now, random });
          return { state: "backoff", sent };
        }
        await succeed(db, now());
      }
    },
    { state: "locked", sent: 0 },
  );
}

const eventResponse = z.object({
  results: z.array(z.object({ id: z.string(), status: z.enum(["recorded", "rejected"]) })),
});

/**
 * Sends queued register events (no-sale drawer opens, refund approvals), oldest first. The server
 * answers per event: `recorded` leaves the device, `rejected` (the approver is no longer a manager,
 * say) stays flagged and is never retried. Any other failure keeps everything and backs off.
 */
async function drainEvents(
  db: RegisterDb,
  fetchFn: typeof fetch,
  opts: Required<Pick<DrainOptions, "now" | "random">>,
): Promise<"ok" | "backoff" | "signed-out"> {
  for (;;) {
    const batch = (await db.events.where("syncState").equals("pending").sortBy("id")).slice(0, 25);
    if (batch.length === 0) return "ok";
    let res: Response;
    try {
      res = await fetchFn("/api/v1/sync/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          events: batch.map((e) => ({
            id: e.id,
            kind: e.kind,
            at: e.at,
            cashierUserId: e.cashierUserId,
            approvalId: e.approvalId,
            claimedApprover: e.claimedApprover,
            detail: e.detail,
          })),
        }),
      });
    } catch {
      await fail(db, opts);
      return "backoff";
    }
    if (res.status === 401 || res.status === 403 || res.status === 404) return "signed-out";
    let results;
    try {
      if (!res.ok) throw new Error(String(res.status));
      results = eventResponse.parse(await res.json()).results;
    } catch {
      await fail(db, opts);
      return "backoff";
    }
    const byId = new Map(results.map((r) => [r.id, r.status]));
    let unresolved = 0;
    await db.transaction("rw", db.events, async () => {
      for (const e of batch) {
        const status = byId.get(e.id);
        if (status === "recorded") await db.events.delete(e.id);
        else if (status === "rejected") await db.events.update(e.id, { syncState: "rejected" });
        else unresolved++;
      }
    });
    if (unresolved > 0) {
      await fail(db, opts);
      return "backoff";
    }
  }
}

/** Tells the server this till is alive (an empty batch), so managers see when it last synced. */
export async function heartbeat(
  db: RegisterDb,
  orgId: string,
  registerId: string,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchFn(`/api/v1/sync/sales?orgId=${encodeURIComponent(orgId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ registerId, sales: [] }),
    });
    if (res.ok) await db.meta.put({ key: "lastContactAt", value: Date.now() });
    return res.ok;
  } catch {
    return false;
  }
}

/** Synced sales older than 30 days leave the device; pending and rejected ones never do. */
async function prune(db: RegisterDb, now: number) {
  const old = await db.sales
    .where("syncState")
    .equals("synced")
    .filter((s) => (s.syncedAt ?? now) < now - KEEP_SYNCED_MS)
    .primaryKeys();
  if (old.length) await db.sales.bulkDelete(old);
}
