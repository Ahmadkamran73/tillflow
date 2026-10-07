"use client";

import { liveQuery } from "dexie";
import { useEffect, useRef, useState } from "react";
import type { RateRow } from "@/lib/money";
import { refreshCatalog, UnpairedError } from "./catalog-sync";
import type { RegisterDb, ParkedSale } from "./db";
import type { Feed } from "./feed";

export type CatalogData = {
  org: Feed["org"] | undefined;
  registers: Feed["registers"];
  staff: Feed["staff"];
  tenderTypes: Feed["tenderTypes"];
  registerId: string | undefined;
  taxRates: RateRow[];
  products: Feed["products"];
  variants: Feed["variants"];
  categories: Feed["categories"];
  modifierGroups: Feed["modifierGroups"];
  modifiers: Feed["modifiers"];
  productGroups: Feed["productGroups"];
  parked: ParkedSale[];
};

/**
 * The register's only data source: IndexedDB, re-read whenever it changes (live query), so a
 * background refresh updates the screen by itself. `null` until the first read.
 */
export function useCatalog(db: RegisterDb | null): CatalogData | null {
  const [data, setData] = useState<CatalogData | null>(null);
  useEffect(() => {
    if (!db) return;
    // ponytail: loads the whole catalogue into memory (fine to a few thousand variants);
    // page or index the grid when a shop outgrows that.
    const sub = liveQuery(async (): Promise<CatalogData> => {
      const [
        org,
        taxRates,
        products,
        variants,
        categories,
        modifierGroups,
        modifiers,
        productGroups,
        parked,
        registers,
        staff,
        tenderTypes,
        registerId,
      ] = await Promise.all([
        db.meta.get("org"),
        db.meta.get("taxRates"),
        db.products.toArray(),
        db.variants.toArray(),
        db.categories.toArray(),
        db.modifierGroups.toArray(),
        db.modifiers.toArray(),
        db.productGroups.toArray(),
        db.parked.orderBy("savedAt").toArray(),
        db.meta.get("registers"),
        db.meta.get("staff"),
        db.meta.get("tenderTypes"),
        db.meta.get("registerId"),
      ]);
      return {
        org: org?.value as Feed["org"] | undefined,
        registers: (registers?.value as Feed["registers"] | undefined) ?? [],
        staff: (staff?.value as Feed["staff"] | undefined) ?? [],
        tenderTypes: (tenderTypes?.value as Feed["tenderTypes"] | undefined) ?? [],
        registerId: registerId?.value as string | undefined,
        taxRates: (taxRates?.value as RateRow[] | undefined) ?? [],
        products,
        variants,
        categories,
        modifierGroups,
        modifiers,
        productGroups,
        parked,
      };
    }).subscribe({ next: setData, error: () => setData(null) });
    return () => sub.unsubscribe();
  }, [db]);
  return data;
}

const REFRESH_MS = 60_000;

/** Refreshes the local catalogue now, every minute and when the network comes back. Never throws. */
export function useCatalogRefresh(db: RegisterDb | null, orgId: string) {
  const [state, setState] = useState({ syncing: false, failed: false, unpaired: false });
  const busy = useRef(false);
  useEffect(() => {
    if (!db) return;
    const run = async () => {
      if (busy.current) return;
      busy.current = true;
      setState((s) => ({ ...s, syncing: true }));
      try {
        await refreshCatalog(db, orgId);
        setState({ syncing: false, failed: false, unpaired: false });
      } catch (e) {
        setState({ syncing: false, failed: true, unpaired: e instanceof UnpairedError });
      } finally {
        busy.current = false;
      }
    };
    void run();
    const timer = setInterval(() => void run(), REFRESH_MS);
    window.addEventListener("online", run);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", run);
    };
  }, [db, orgId]);
  return state;
}
