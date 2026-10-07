import Dexie, { type Table } from "dexie";
import type { Feed } from "./feed";
import { localDate, type RateRow } from "@/lib/money";
import { priceCart, type Cart } from "./cart";
import type { TenderInput } from "./tender-input";

export type ParkedSale = { id: string; savedAt: number; cart: Cart };
/** A payment on a sale: what travels (`TenderInput`) plus the type's label, for receipts. */
export type LocalTender = TenderInput & { label: string };
export type SyncState = "pending" | "synced" | "rejected";

/**
 * A finished sale in the device’s outbox (docs/specs/offline-sale-sync.md). Written before any
 * network call; a row is only ever removed after the server confirmed it (and 30 days later).
 */
export type LocalSale = {
  /** UUIDv7; also the idempotency key. Sorts by time, so the outbox drains oldest first. */
  id: string;
  registerId: string;
  /** Who rang it up (their PIN unlocked the till). Missing only on sales queued before step 1.7. */
  cashierUserId?: string;
  /** The server's proof of a manager PIN for a discount above the shop's limit (online approvals only). */
  approvalId?: string;
  receiptSeq: number;
  completedAt: string;
  /** Inputs only: totals are always re-derived with `priceCart`. */
  cart: Cart;
  /** Cash handed over, card and voucher amounts, card tips; the server re-checks they add up. */
  tenders: LocalTender[];
  /** Whether the shop rounded cash to 5c when this sale was made (its preset then); missing = yes. */
  roundCash?: boolean;
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
  "id" | "registerId" | "receiptSeq" | "completedAt" | "cart" | "tenders" | "invoice" | "roundCash"
>;
export type Meta = { key: string; value: unknown };

/**
 * Something a manager approved outside a sale (drawer opened with no sale, refund override),
 * queued like a sale and sent to /api/v1/sync/events. Becomes an audit_log row on the server.
 */
export type RegisterEvent = {
  /** UUIDv7; also the audit row's id on the server, so a replay writes nothing twice. */
  id: string;
  kind: "no_sale" | "refund_override";
  at: string;
  cashierUserId: string;
  /** The server's proof of the manager's PIN; absent when it was checked offline. */
  approvalId?: string;
  /** Who the till says approved it (offline only): sent as a claim, never trusted. */
  claimedApprover?: string;
  detail: Record<string, string | number | boolean>;
  syncState: SyncState;
};

/** PIN failures counted on this device, so the 5-failure lockout also holds while offline. */
export type PinAttempts = { userId: string; failed: number; lockedUntil?: number };

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
  events!: Table<RegisterEvent, string>;
  pinAttempts!: Table<PinAttempts, string>;

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
              sale.expectedDueCents = priceCart(
                sale.cart as Cart,
                {
                  country: org?.country ?? "IE",
                  date: localDate(
                    new Date(sale.completedAt as string),
                    org?.timezone ?? "Europe/Dublin",
                  ),
                  rates: rates ?? [],
                },
                "cash",
              ).basket.amountDue;
            } catch {
              // Cannot be priced here: the server will reject it and a manager will see it.
              sale.expectedDueCents = 0;
            }
          });
      });
    // v4 (step 1.7): staff PINs. Sales queued before this have no cashier; the server will not
    // accept them as anyone's and a manager sees them under Needs attention.
    this.version(4).stores({
      events: "id, syncState",
      pinAttempts: "userId",
    });
    // v5 (step 2.1): a sale carries a list of payments. Older sales had one cash amount handed over.
    this.version(5)
      .stores({})
      .upgrade(async (tx) => {
        await tx
          .table("sales")
          .toCollection()
          .modify((sale: Record<string, unknown>) => {
            if (Array.isArray(sale.tenders)) return;
            sale.tenders = [
              {
                id: sale.id,
                typeId: null,
                method: "cash",
                amountCents: sale.tenderedCents ?? 0,
                tipCents: 0,
                label: "Cash",
              },
            ];
            delete sale.tenderedCents;
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
