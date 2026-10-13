import { v7 as uuidv7 } from "uuid";
import type { Cart } from "./cart";
import type { LocalSale, LocalTender, RegisterDb } from "./db";
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
  input: {
    registerId: string;
    cashierUserId: string;
    /** Set only when a discount above the shop's limit was approved with a manager's PIN (online). */
    approvalId?: string;
    /** An exchange sale: its id was made first, because its refund names it. */
    id?: string;
    /** An exchange sale: the refund whose returned goods pay for part of it. */
    exchangeRefundId?: string;
    /** The customer rung up for, if one was picked. */
    customerId?: string;
    tabId?: string;
    cart: Cart;
    tenders: LocalTender[];
    roundCash?: boolean;
    /** What the shop is paid for the sale: total plus the 5c rounding on the cash share. */
    expectedDueCents: number;
    expectedVatCents?: number;
  },
): Promise<LocalSale> {
  return db.transaction("rw", db.meta, db.sales, async () => {
    const shift = (await db.meta.get("currentShift"))?.value as { id: string } | undefined;
    const key = `receiptSeq:${input.registerId}`;
    const local = ((await db.meta.get(key))?.value as number | undefined) ?? 0;
    const registers = (await db.meta.get("registers"))?.value as Feed["registers"] | undefined;
    const known = registers?.find((r) => r.id === input.registerId)?.lastSeq ?? 0;
    const seq = Math.max(local, known) + 1;
    const pulledAt = (await db.meta.get("pulledAt"))?.value;
    const sale: LocalSale = {
      id: input.id ?? uuidv7(),
      registerId: input.registerId,
      cashierUserId: input.cashierUserId,
      approvalId: input.approvalId,
      shiftId: shift?.id,
      customerId: input.customerId,
      tabId: input.tabId,
      receiptSeq: seq,
      completedAt: new Date().toISOString(),
      cart: input.cart,
      tenders: input.tenders,
      roundCash: input.roundCash ?? true,
      expectedDueCents: input.expectedDueCents,
      expectedVatCents: input.expectedVatCents,
      catalogAsOf: typeof pulledAt === "string" ? pulledAt : undefined,
      exchangeRefundId: input.exchangeRefundId,
      syncState: "pending",
      attempts: 0,
    };
    await db.meta.put({ key, value: seq });
    await db.sales.add(sale);
    // In the same transaction as the outbox write: a crash can never leave the finished cart (or
    // its card payments) behind to be restored and rung up a second time.
    await db.meta.delete("currentCart");
    await db.meta.delete("tenderDraft");
    if (input.exchangeRefundId) await db.meta.delete("exchangeDraft");
    return sale;
  });
}

export const setInvoice = (db: RegisterDb, id: string, invoice: LocalSale["invoice"]) =>
  db.sales.update(id, { invoice });
