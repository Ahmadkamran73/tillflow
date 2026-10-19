import { feedSchema } from "./feed";
import type { RegisterDb } from "./db";

/** The server no longer knows this device (revoked, replaced, or never paired): pair it again. */
export class UnpairedError extends Error {}

/**
 * Pulls what changed since the stored cursor and applies it in one local transaction, so the
 * screens never see half a catalogue. Throws when offline or signed out; callers just keep
 * showing the local copy. Archived products and variants are removed from the device.
 */
export async function refreshCatalog(db: RegisterDb, orgId: string): Promise<void> {
  const cursor = (await db.meta.get("cursor"))?.value;
  const url = `/api/v1/catalog/${orgId}${typeof cursor === "string" ? `?since=${encodeURIComponent(cursor)}` : ""}`;
  const res = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new UnpairedError();
  // A redirect (to a login page, say) is HTML, which must not parse as a feed.
  if (!res.ok || res.redirected) throw new Error(`catalogue refresh failed (${res.status})`);
  const feed = feedSchema.parse(await res.json());

  const live = <T extends { archived: boolean }>(rows: T[]) => rows.filter((r) => !r.archived);
  const gone = <T extends { id: string; archived: boolean }>(rows: T[]) =>
    rows.filter((r) => r.archived).map((r) => r.id);

  await db.transaction(
    "rw",
    [
      db.products,
      db.variants,
      db.categories,
      db.modifierGroups,
      db.modifiers,
      db.productGroups,
      db.meta,
    ],
    async () => {
      if (feed.full) await Promise.all([db.products.clear(), db.variants.clear()]);
      await Promise.all([
        db.products.bulkDelete(gone(feed.products)),
        db.variants.bulkDelete(gone(feed.variants)),
      ]);
      await Promise.all([
        db.products.bulkPut(live(feed.products)),
        db.variants.bulkPut(live(feed.variants)),
        // Small tables whose rows can be deleted: replaced whole every time.
        db.categories.clear().then(() => db.categories.bulkPut(feed.categories)),
        db.modifierGroups.clear().then(() => db.modifierGroups.bulkPut(feed.modifierGroups)),
        db.modifiers.clear().then(() => db.modifiers.bulkPut(feed.modifiers)),
        db.productGroups.clear().then(() => db.productGroups.bulkPut(feed.productGroups)),
        db.meta.bulkPut([
          { key: "org", value: feed.org },
          { key: "registers", value: feed.registers },
          // Who can unlock the till, with their PIN hashes (Argon2) for checking a PIN offline.
          { key: "staff", value: feed.staff },
          { key: "taxRates", value: feed.taxRates },
          { key: "tenderTypes", value: feed.tenderTypes },
          // Restaurants: the floor plan, replaced whole every time (tables can be archived).
          { key: "floorPlan", value: { floors: feed.floors, tables: feed.tables } },
          { key: "cursor", value: feed.cursor },
          // When this device last saw the server’s prices: sent with each sale (`catalogAsOf`).
          { key: "pulledAt", value: feed.serverTime },
        ]),
      ]);
    },
  );
}
