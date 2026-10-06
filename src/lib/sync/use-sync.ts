"use client";

import { liveQuery } from "dexie";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RegisterDb } from "@/lib/register/db";
import type { SyncState } from "@/components/sync-status-pill";
import { drainOutbox, heartbeat, type DrainState } from "./outbox";

const DRAIN_EVERY_MS = 30_000;
const HEARTBEAT_EVERY_MS = 5 * 60_000;
export const OFFLINE_WARNING_MS = 24 * 3_600_000;

export type SyncView = {
  /** What the status pill shows. */
  pill: SyncState;
  /** Sales waiting to be sent (survives a reload: it is counted from IndexedDB). */
  waiting: number;
  /** Sales the server refused; a manager sees them under Needs attention. */
  rejected: number;
  /** Waiting sales, or no contact with the server, for more than 24 hours. */
  staleHours: number | null;
  /** The session ended: sales are safe on the device, sign in again to send them. */
  signedOut: boolean;
  /** Send now (after a sale, once its receipt has printed). */
  kick: () => void;
};

type Counts = {
  waiting: number;
  rejected: number;
  oldest: number | null;
  lastContact: number | null;
};

/**
 * The in-page half of background sync (the service worker's Background Sync is the other half; the
 * same `drainOutbox` runs in both, behind one lock, so they never double-send). Drains on load, after
 * a sale, when the network returns, and every 30 seconds. Never blocks the UI.
 */
export function useSync(
  db: RegisterDb | null,
  orgId: string,
  registerId: string | undefined,
  catalogueFailed: boolean,
): SyncView {
  const [counts, setCounts] = useState<Counts>({
    waiting: 0,
    rejected: 0,
    oldest: null,
    lastContact: null,
  });
  const [syncing, setSyncing] = useState(false);
  const [last, setLast] = useState<DrainState>("idle");
  const [online, setOnline] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const busy = useRef(false);
  const waitingRef = useRef(0);
  const lastBeat = useRef(0);

  useEffect(() => {
    if (!db) return;
    const sub = liveQuery(async (): Promise<Counts> => {
      const [pending, rejected, contact] = await Promise.all([
        db.sales.where("syncState").equals("pending").sortBy("id"),
        db.sales.where("syncState").equals("rejected").count(),
        db.meta.get("lastContactAt"),
      ]);
      const oldest = pending[0] ? new Date(pending[0].completedAt).getTime() : null;
      return {
        waiting: pending.length,
        rejected,
        oldest,
        lastContact: typeof contact?.value === "number" ? contact.value : null,
      };
    }).subscribe({
      next: (c) => {
        waitingRef.current = c.waiting;
        setCounts(c);
      },
      error: () => {},
    });
    return () => sub.unsubscribe();
  }, [db]);

  const run = useCallback(
    async (force: boolean) => {
      if (!db || busy.current) return;
      busy.current = true;
      // Idle polls stay silent: the pill only says "Syncing" when there is something to send.
      if (force || waitingRef.current > 0) setSyncing(true);
      try {
        const res = await drainOutbox(db, orgId, { force });
        if (res.state !== "locked") setLast(res.state);
        // Nothing to send and the server answered earlier: tell it this till is alive.
        if (
          res.state === "idle" &&
          registerId &&
          Date.now() - lastBeat.current > HEARTBEAT_EVERY_MS
        ) {
          lastBeat.current = Date.now();
          if (!(await heartbeat(db, orgId, registerId))) setLast("backoff");
        }
      } catch {
        setLast("backoff");
      } finally {
        busy.current = false;
        setSyncing(false);
      }
    },
    [db, orgId, registerId],
  );

  useEffect(() => {
    if (!db) return;
    const onOnline = () => {
      setOnline(true);
      void run(true);
    };
    const onOffline = () => setOnline(false);
    // Reading navigator.onLine once on mount; the events keep it current after that.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOnline(navigator.onLine);
    void run(false);
    const drain = setInterval(() => void run(false), DRAIN_EVERY_MS);
    const clock = setInterval(() => setNow(Date.now()), 60_000);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      clearInterval(drain);
      clearInterval(clock);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [db, run]);

  const kick = useCallback(() => {
    void run(true);
    // Ask the service worker to finish the job even if this tab closes (not in every browser).
    void navigator.serviceWorker?.ready
      .then((reg) =>
        (
          reg as ServiceWorkerRegistration & { sync?: { register(t: string): Promise<void> } }
        ).sync?.register(`sales:${orgId}`),
      )
      .catch(() => {});
  }, [run, orgId]);

  const down = !online || last === "backoff" || last === "signed-out" || catalogueFailed;
  const pill: SyncState = syncing
    ? "syncing"
    : down
      ? "offline"
      : counts.waiting > 0
        ? "syncing"
        : "online";

  const oldestAge = counts.oldest === null ? 0 : now - counts.oldest;
  const sinceContact = counts.lastContact === null ? 0 : now - counts.lastContact;
  const stale = counts.waiting > 0 && Math.max(oldestAge, sinceContact) > OFFLINE_WARNING_MS;

  return {
    pill,
    waiting: counts.waiting,
    rejected: counts.rejected,
    staleHours: stale ? Math.floor(Math.max(oldestAge, sinceContact) / 3_600_000) : null,
    signedOut: last === "signed-out",
    kick,
  };
}
