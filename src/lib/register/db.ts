import Dexie, { type Table } from "dexie";
import type { Feed } from "./feed";
import type { Cart } from "./cart";

export type ParkedSale = { id: string; savedAt: number; cart: Cart };
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
  }
}

const open = new Map<string, RegisterDb>();

export function registerDb(orgId: string): RegisterDb {
  let db = open.get(orgId);
  if (!db) open.set(orgId, (db = new RegisterDb(orgId)));
  return db;
}
