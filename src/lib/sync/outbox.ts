import { z } from "zod";
import type { LocalRefund, LocalSale, RegisterDb } from "@/lib/register/db";
import { refundResponse, type SyncRefund } from "./refund-protocol";
import { toWireTender } from "@/lib/register/tender-input";
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
 * Pending sales that can go now: an exchange sale waits until the refund that pays for it has
 * reached the server (the server would otherwise have no credit to take).
 */
export async function sendableSales(db: RegisterDb): Promise<LocalSale[]> {
  const pending = await pendingSales(db);
  if (!pending.some((s) => s.exchangeRefundId)) return pending;
  const waiting = new Set(
    (await db.refunds.where("syncState").equals("pending").primaryKeys()) as string[],
  );
  return pending.filter((s) => !s.exchangeRefundId || !waiting.has(s.exchangeRefundId));
}

/**
 * Pending refunds that can go now: a refund waits while the sale it refunds is still in this
 * device's outbox (the server cannot refund a sale it has not got).
 */
export async function sendableRefunds(db: RegisterDb): Promise<LocalRefund[]> {
  const pending = await db.refunds.where("syncState").equals("pending").sortBy("id");
  if (pending.length === 0) return pending;
  const waiting = new Set(
    (await db.sales.where("syncState").equals("pending").primaryKeys()) as string[],
  );
  return pending.filter((r) => !waiting.has(r.originalSaleId));
}

/**
 * An exchange sale whose refund the server refused cannot be sent: the server would wait for a
 * refund that will never come and hold up everything behind it. Mark it rejected on the device so
 * the cashier's notice shows it; the refund's own rejection is already in Needs attention.
 */
async function failOrphanedExchangeSales(db: RegisterDb) {
  const waiting = await db.sales
    .where("syncState")
    .equals("pending")
    .filter((s) => !!s.exchangeRefundId)
    .toArray();
  for (const s of waiting) {
    const refund = await db.refunds.get(s.exchangeRefundId!);
    if (refund?.syncState === "rejected") {
      await db.sales.update(s.id, { syncState: "rejected", rejectReason: "exchange_refund_rejected" });
    }
  }
}

const toWireRefund = (r: LocalRefund): SyncRefund => ({
  id: r.id,
  originalSaleId: r.originalSaleId,
  kind: r.kind,
  reasonCode: r.reasonCode,
  reasonNote: r.reasonNote,
  receiptSeq: r.receiptSeq,
  completedAt: r.completedAt,
  cashierUserId: r.cashierUserId,
  approvalId: r.approvalId,
  claimedApprover: r.claimedApprover,
  lines: r.lines.map((l) => ({ lineNo: l.lineNo, qty: l.qty, restock: l.restock })),
  // The till's label stays on the device (it is for the receipt).
  legs: r.legs.map((l) => ({
    id: l.id,
    typeId: l.typeId,
    method: l.method,
    amountCents: l.amountCents,
    tipCents: l.tipCents,
    ...(l.reference ? { reference: l.reference } : {}),
  })),
  exchangeSaleId: r.exchangeSaleId,
  creditCents: r.creditCents,
  roundCash: r.roundCash,
  expectedAmountCents: r.expectedAmountCents,
});

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
  tenders: s.tenders.map(toWireTender),
  roundCash: s.roundCash ?? true,
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

        await failOrphanedExchangeSales(db);
        const pending = await sendableSales(db);
        if (pending.length === 0) {
          // Sales first, then the refunds of them (an exchange sale waits for its refund above).
          const due = await sendableRefunds(db);
          if (due.length > 0) {
            const r = await sendRefunds(db, orgId, fetchFn, due.slice(0, MAX_BATCH), { now, random });
            if (r.state !== "ok") return { state: r.state, sent };
            sent += r.sent;
            continue;
          }
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

/**
 * Sends a batch of pending refunds, one till at a time. The server answers per refund: created or
 * duplicate = synced; rejected = kept and flagged to a manager; retry = the sale it refunds has not
 * reached the server yet, so the refund stays queued and the drain backs off.
 */
async function sendRefunds(
  db: RegisterDb,
  orgId: string,
  fetchFn: typeof fetch,
  batch: LocalRefund[],
  opts: Required<Pick<DrainOptions, "now" | "random">>,
): Promise<{ state: "ok"; sent: number } | { state: "backoff" | "signed-out"; sent: number }> {
  const registerId = batch[0]!.registerId;
  const group = batch.filter((r) => r.registerId === registerId);
  let res: Response;
  try {
    res = await fetchFn(`/api/v1/sync/refunds?orgId=${encodeURIComponent(orgId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ registerId, refunds: group.map(toWireRefund) }),
    });
  } catch {
    await fail(db, opts);
    return { state: "backoff", sent: 0 };
  }
  if (res.status === 401 || res.status === 403) return { state: "signed-out", sent: 0 };
  let results;
  try {
    if (!res.ok) throw new Error(String(res.status));
    results = refundResponse.parse(await res.json()).results;
  } catch {
    await fail(db, opts);
    return { state: "backoff", sent: 0 };
  }
  const byId = new Map(results.map((r) => [r.id, r]));
  let unresolved = 0;
  await db.transaction("rw", db.refunds, async () => {
    for (const refund of group) {
      const r = byId.get(refund.id);
      if (!r || r.status === "retry") {
        unresolved++;
        await db.refunds.update(refund.id, { attempts: refund.attempts + 1 });
      } else if (r.status === "rejected") {
        await db.refunds.update(refund.id, { syncState: "rejected", rejectReason: r.reason });
      } else {
        await db.refunds.update(refund.id, { syncState: "synced", syncedAt: opts.now() });
      }
    }
  });
  const sent = group.length - unresolved;
  if (unresolved > 0) {
    await fail(db, opts);
    return { state: "backoff", sent };
  }
  await succeed(db, opts.now());
  return { state: "ok", sent };
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
  const oldRefunds = await db.refunds
    .where("syncState")
    .equals("synced")
    .filter((r) => (r.syncedAt ?? now) < now - KEEP_SYNCED_MS)
    .primaryKeys();
  if (oldRefunds.length) await db.refunds.bulkDelete(oldRefunds);
}
