import { v7 as uuidv7 } from "uuid";
import { expectedCash, overShort, sumMovements } from "@/lib/money";
import type { CurrentShift, LocalShiftEvent, RegisterDb } from "./db";

/**
 * The till's side of a shift (docs/specs/shifts.md). Everything is written to IndexedDB first and
 * synced later, like sales. The figures here come from what the till stored; the server works out
 * its own and its Z is the one that counts (a difference is flagged for the owner).
 */

export const currentShift = async (db: RegisterDb): Promise<CurrentShift | undefined> =>
  (await db.meta.get("currentShift"))?.value as CurrentShift | undefined;

/** Opens a shift with a float; if one is already open it is returned unchanged. */
export function openShift(
  db: RegisterDb,
  input: { registerId: string; cashierUserId: string; floatCents: number },
): Promise<CurrentShift> {
  if (!Number.isInteger(input.floatCents) || input.floatCents < 0) {
    return Promise.reject(new RangeError("float must be whole cents, 0 or more"));
  }
  return db.transaction("rw", db.meta, db.shiftEvents, async () => {
    const existing = await currentShift(db);
    if (existing) return existing;
    const id = uuidv7();
    const at = new Date().toISOString();
    const shift: CurrentShift = {
      id,
      registerId: input.registerId,
      openedAt: at,
      floatCents: input.floatCents,
      cashierUserId: input.cashierUserId,
    };
    await db.shiftEvents.add({
      id,
      kind: "open",
      shiftId: id,
      registerId: input.registerId,
      at,
      cashierUserId: input.cashierUserId,
      floatCents: input.floatCents,
      syncState: "pending",
    });
    await db.meta.put({ key: "currentShift", value: shift });
    return shift;
  });
}

export async function addCashMove(
  db: RegisterDb,
  shift: CurrentShift,
  input: { cashierUserId: string; movement: "in" | "out"; amountCents: number; note: string },
): Promise<void> {
  const note = input.note.trim();
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1) throw new RangeError("amount");
  if (note.length < 1 || note.length > 200) throw new RangeError("note");
  await db.shiftEvents.add({
    id: uuidv7(),
    kind: "cash",
    shiftId: shift.id,
    registerId: shift.registerId,
    at: new Date().toISOString(),
    cashierUserId: input.cashierUserId,
    movement: input.movement,
    amountCents: input.amountCents,
    note,
    syncState: "pending",
  });
}

export type ShiftSummary = {
  saleCount: number;
  salesCents: number;
  vatCents: number;
  cashSalesCents: number;
  cardSalesCents: number;
  tipsCents: number;
  refundCount: number;
  refundCents: number;
  cashRefundsCents: number;
  cardRefundsCents: number;
  floatCents: number;
  cashInCents: number;
  cashOutCents: number;
  expectedCents: number;
  /** Sales/refunds the server refused: they are not in the shift's totals. */
  rejectedCount: number;
};

/**
 * The shift's figures from what is stored on the device. A sale's cash is what it was due less the
 * card and exchange credit that paid for it (cash settles the rest, change already taken out).
 */
export async function summariseShift(db: RegisterDb, shift: CurrentShift): Promise<ShiftSummary> {
  const [sales, refunds, events] = await Promise.all([
    db.sales.filter((s) => s.shiftId === shift.id).toArray(),
    db.refunds.filter((r) => r.shiftId === shift.id).toArray(),
    db.shiftEvents.where("shiftId").equals(shift.id).toArray(),
  ]);
  const okSales = sales.filter((s) => s.syncState !== "rejected");
  const okRefunds = refunds.filter((r) => r.syncState !== "rejected");
  let cashSales = 0;
  let cardSales = 0;
  let tips = 0;
  for (const s of okSales) {
    const noncash = s.tenders
      .filter((t) => t.method !== "cash")
      .reduce((n, t) => n + t.amountCents, 0);
    cashSales += s.expectedDueCents - noncash;
    for (const t of s.tenders) {
      if (t.method === "card") {
        cardSales += t.amountCents;
        tips += t.tipCents ?? 0;
      }
    }
  }
  let cashRefunds = 0;
  let cardRefunds = 0;
  for (const r of okRefunds) {
    for (const l of r.legs) {
      if (l.method === "cash") cashRefunds += l.amountCents;
      else cardRefunds += l.amountCents;
    }
  }
  const { cashIn, cashOut } = sumMovements(
    events
      .filter((e) => e.kind === "cash")
      .map((e) => ({ kind: e.movement!, amount: e.amountCents! })),
  );
  return {
    saleCount: okSales.length,
    salesCents: okSales.reduce((n, s) => n + s.expectedDueCents, 0),
    vatCents: okSales.reduce((n, s) => n + (s.expectedVatCents ?? 0), 0),
    cashSalesCents: cashSales,
    cardSalesCents: cardSales,
    tipsCents: tips,
    refundCount: okRefunds.length,
    refundCents: okRefunds.reduce((n, r) => n + r.expectedAmountCents, 0),
    cashRefundsCents: cashRefunds,
    cardRefundsCents: cardRefunds,
    floatCents: shift.floatCents,
    cashInCents: cashIn,
    cashOutCents: cashOut,
    expectedCents: expectedCash({
      float: shift.floatCents,
      cashSales,
      cashIn,
      cashOut,
      cashRefunds,
    }),
    rejectedCount: sales.length - okSales.length + (refunds.length - okRefunds.length),
  };
}

export type ClosedShift = {
  shiftId: string;
  registerId: string;
  openedAt: string;
  closedAt: string;
  countedCents: number;
  overShortCents: number;
  summary: ShiftSummary;
};

/**
 * Closes the open shift with the counted cash: queues the close (it goes to the server once every
 * sale and refund of the shift has) and keeps the figures for reprinting. Selling is blocked again
 * until a new shift is opened.
 */
export function closeShift(
  db: RegisterDb,
  shift: CurrentShift,
  input: { cashierUserId: string; countedCents: number },
): Promise<ClosedShift> {
  if (!Number.isInteger(input.countedCents) || input.countedCents < 0) {
    return Promise.reject(new RangeError("counted must be whole cents, 0 or more"));
  }
  return db.transaction("rw", [db.meta, db.shiftEvents, db.sales, db.refunds], async () => {
    const current = await currentShift(db);
    if (!current || current.id !== shift.id) throw new Error("that shift is not open");
    const summary = await summariseShift(db, shift);
    const closedAt = new Date().toISOString();
    const event: LocalShiftEvent = {
      id: uuidv7(),
      kind: "close",
      shiftId: shift.id,
      registerId: shift.registerId,
      at: closedAt,
      cashierUserId: input.cashierUserId,
      countedCents: input.countedCents,
      expectedCents: summary.expectedCents,
      saleCount: summary.saleCount,
      refundCount: summary.refundCount,
      rejectedCount: summary.rejectedCount,
      syncState: "pending",
    };
    await db.shiftEvents.add(event);
    await db.meta.delete("currentShift");
    const closed: ClosedShift = {
      shiftId: shift.id,
      registerId: shift.registerId,
      openedAt: shift.openedAt,
      closedAt,
      countedCents: input.countedCents,
      overShortCents: overShort(input.countedCents, summary.expectedCents),
      summary,
    };
    await db.meta.put({ key: "lastClosedShift", value: closed });
    return closed;
  });
}
