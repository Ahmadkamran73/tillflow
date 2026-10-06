import { v7 as uuidv7 } from "uuid";
import type { Cart } from "./cart";
import type { LocalSale, RegisterDb } from "./db";
import type { Feed } from "./feed";

/** "Till 1 · 000042" */
export const receiptNo = (registerName: string, seq: number) =>
  `${registerName} · ${String(seq).padStart(6, "0")}`;

/**
 * Saves a finished sale in the outbox (state `pending`) and gives it the next receipt number for
 * its till, in one transaction so numbers are sequential and gap-free per till on this device.
 * Nothing here touches the network: the receipt prints first, the sync drain runs afterwards.
 * The number carries on after the highest one the server holds for this till (`lastSeq`, from the
 * catalogue feed), so a device whose browser data was cleared never repeats a number.
 */
export async function completeSale(
  db: RegisterDb,
  input: { registerId: string; cart: Cart; tenderedCents: number; expectedDueCents: number },
): Promise<LocalSale> {
  return db.transaction("rw", db.meta, db.sales, async () => {
    const key = `receiptSeq:${input.registerId}`;
    const local = ((await db.meta.get(key))?.value as number | undefined) ?? 0;
    const registers = (await db.meta.get("registers"))?.value as Feed["registers"] | undefined;
    const known = registers?.find((r) => r.id === input.registerId)?.lastSeq ?? 0;
    const seq = Math.max(local, known) + 1;
    const pulledAt = (await db.meta.get("pulledAt"))?.value;
    const sale: LocalSale = {
      id: uuidv7(),
      registerId: input.registerId,
      receiptSeq: seq,
      completedAt: new Date().toISOString(),
      cart: input.cart,
      tenderedCents: input.tenderedCents,
      expectedDueCents: input.expectedDueCents,
      catalogAsOf: typeof pulledAt === "string" ? pulledAt : undefined,
      syncState: "pending",
      attempts: 0,
    };
    await db.meta.put({ key, value: seq });
    await db.sales.add(sale);
    return sale;
  });
}

export const setInvoice = (db: RegisterDb, id: string, invoice: LocalSale["invoice"]) =>
  db.sales.update(id, { invoice });
