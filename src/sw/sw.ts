import {
  NetworkFirst,
  NetworkOnly,
  Serwist,
  type PrecacheEntry,
  type SerwistGlobalConfig,
} from "serwist";
import { RegisterDb } from "@/lib/register/db";
import { drainOutbox } from "@/lib/sync/outbox";

// The register's service worker (docs/specs/offline-sale-sync.md). Two jobs:
//   1. keep the register page loading with no network (precached build files + the last good page);
//   2. finish sending the outbox when the browser says the network is back (Background Sync),
//      even if the till tab was closed. The page runs the same drain as a fallback; both take the
//      same lock and the server ignores replays, so they never double-send.
// Compiled by @serwist/next (webpack build only; off in `next dev`) and type-checked with
// src/sw/tsconfig.json (webworker types), so it is excluded from the root tsconfig.

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}
declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  runtimeCaching: [
    // Never cache the API: sync and the catalogue must always reach the server, or fail honestly.
    { matcher: ({ url }) => url.pathname.startsWith("/api/"), handler: new NetworkOnly() },
    {
      // The register page itself: the network when it answers, the last good copy when it does not.
      matcher: ({ request, url }) =>
        request.mode === "navigate" && url.pathname.startsWith("/register/"),
      handler: new NetworkFirst({ cacheName: "register-pages", networkTimeoutSeconds: 3 }),
    },
  ],
});
serwist.addEventListeners();

type SyncEvent = ExtendableEvent & { tag: string };

self.addEventListener("sync", (event) => {
  const { tag } = event as SyncEvent;
  if (!tag.startsWith("sales:")) return;
  const orgId = tag.slice("sales:".length);
  (event as SyncEvent).waitUntil(
    drainOutbox(new RegisterDb(orgId), orgId, { force: true }).then((r) => {
      // Not finished (offline again, server busy): ask the browser to try again later.
      if (r.state === "backoff") throw new Error("outbox not drained");
    }),
  );
});
