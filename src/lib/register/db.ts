import Dexie, { type Table } from "dexie";
import type { Feed } from "./feed";
import { localDate, type RateRow } from "@/lib/money";
import { priceCart, type Cart } from "./cart";

export type ParkedSale = { id: string; savedAt: number; cart: Cart };
export type SyncState = "pending" | "synced" | "rejected";

/**
 * A finished sale in the device’s outbox (docs/specs/offline-sale-sync.md). Written before any
 * network call; a row is only ever removed after the server confirmed it (and 30 days later).
 */
export type LocalSale = {
  /** UUIDv7; also the idempotency key. Sorts by time, so the outbox drains oldest first. */
  id: string;
  registerId: string;
  receiptSeq: number;
  completedAt: string;
  /** Inputs only: totals are always re-derived with `priceCart`. */
  cart: Cart;
  tenderedCents: number;
  /** What the till charged; the server recalculates and compares (within 1c). */
  expectedDueCents: number;
  /** When this till last pulled the catalogue: lets the server price at what the till showed. */
  catalogAsOf?: string;
  syncState: SyncState;
  attempts: number;
  syncedAt?: number;
  /** Why the server refused it (a manager sees it under Needs attention). */
  rejectReason?: string;
  invoice?: { name: string; address: string; vatNumber: string };
};
/** The part of a sale a receipt is built from (also what an emailed receipt is rebuilt from). */
export type ReceiptSale = Pick<
  LocalSale,
  "id" | "registerId" | "receiptSeq" | "completedAt" | "cart" | "tenderedCents" | "invoice"
>;
export type Meta = { key: string; value: unknown };

/**
 * The register's local copy of the shop's catalogue (docs/PLAN.md section 9). The screens read
 * only from here; `catalog-sync.ts` is the only writer. One database per shop, so two shops on a
 * shared device never see each other's data. Holds no customer data and no cost prices.
 */
export class RegisterDb extends Dexie {
  products!: Table<Feed["products"][number], string>;
  variants!: Table<Feed["variants"][number], string>;
  categories!: Table<Feed["categories"][number], string>;
  modifierGroups!: Table<Feed["modifierGroups"][number], string>;
  modifiers!: Table<Feed["modifiers"][number], string>;
  productGroups!: Table<Feed["productGroups"][number], string>;
  meta!: Table<Meta, string>;
  parked!: Table<ParkedSale, string>;
  sales!: Table<LocalSale, string>;

  constructor(orgId: string) {
    super(`tillflow-${orgId}`);
    this.version(1).stores({
      products: "id",
      variants: "id, productId, barcode",
      categories: "id",
      modifierGroups: "id",
      modifiers: "id, groupId",
      productGroups: "id, productId",
      meta: "key",
      parked: "id, savedAt",
    });
    this.version(2).stores({ sales: "id, completedAt" });
    // v3: the sales table becomes the sync outbox. Sales from before sync existed are queued
    // like any other (their expected total is worked out once, here, from the cached rates).
    this.version(3)
      .stores({ sales: "id, completedAt, syncState" })
      .upgrade(async (tx) => {
        const rates = (await tx.table("meta").get("taxRates"))?.value as RateRow[] | undefined;
        const org = (await tx.table("meta").get("org"))?.value as Feed["org"] | undefined;
        await tx
          .table("sales")
          .toCollection()
          .modify((sale: Record<string, unknown>) => {
            sale.syncState = "pending";
            sale.attempts = 0;
            try {
              sale.expectedDueCents = priceCart(sale.cart as Cart, {
                country: org?.country ?? "IE",
                date: localDate(
                  new Date(sale.completedAt as string),
                  org?.timezone ?? "Europe/Dublin",
                ),
                rates: rates ?? [],
              }).basket.amountDue;
            } catch {
              // Cannot be priced here: the server will reject it and a manager will see it.
              sale.expectedDueCents = 0;
            }
          });
      });
  }
}

const open = new Map<string, RegisterDb>();

export function registerDb(orgId: string): RegisterDb {
  let db = open.get(orgId);
  if (!db) open.set(orgId, (db = new RegisterDb(orgId)));
  return db;
}
