import { v7 as uuidv7 } from "uuid";
import type { Cart } from "./cart";
import type { LocalSale, RegisterDb } from "./db";

/** "Till 1 · 000042" */
export const receiptNo = (registerName: string, seq: number) =>
  `${registerName} · ${String(seq).padStart(6, "0")}`;

/**
 * Saves a finished sale on the device and gives it the next receipt number for its till, in one
 * transaction so numbers are sequential and gap-free per till on this device.
 * ponytail: two devices set to the same till, or cleared browser data, can repeat a number;
 * sync (1.6) and pairing (1.7) make the series server-owned.
 */
export async function completeSale(
  db: RegisterDb,
  input: { registerId: string; cart: Cart; tenderedCents: number },
): Promise<LocalSale> {
  return db.transaction("rw", db.meta, db.sales, async () => {
    const key = `receiptSeq:${input.registerId}`;
    const seq = (((await db.meta.get(key))?.value as number | undefined) ?? 0) + 1;
    const sale: LocalSale = {
      id: uuidv7(),
      registerId: input.registerId,
      receiptSeq: seq,
      completedAt: new Date().toISOString(),
      cart: input.cart,
      tenderedCents: input.tenderedCents,
    };
    await db.meta.put({ key, value: seq });
    await db.sales.add(sale);
    return sale;
  });
}

export const setInvoice = (db: RegisterDb, id: string, invoice: LocalSale["invoice"]) =>
  db.sales.update(id, { invoice });
