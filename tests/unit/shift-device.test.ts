import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import type { Cart } from "@/lib/register/cart";
import { RegisterDb } from "@/lib/register/db";
import { completeSale } from "@/lib/register/sale";
import {
  addCashMove,
  closeShift,
  currentShift,
  openShift,
  summariseShift,
} from "@/lib/register/shift";
import { drainOutbox } from "@/lib/sync/outbox";

const ORG = "00000000-0000-4000-8000-0000000000f2";
const REG = "00000000-0000-4000-8000-0000000000e2";
const CASHIER = "00000000-0000-4000-8000-0000000000d2";

const cart: Cart = {
  ageChecked: true,
  lines: [
    {
      id: "0",
      variantId: "00000000-0000-4000-8000-000000000002",
      productId: "p",
      name: "Tea",
      unitPriceCents: 350,
      modifiers: [],
      qty: 1,
      taxCategory: "STANDARD",
      takeawayTaxCategory: null,
      depositCents: 0,
    },
  ],
};
const cash = (amountCents: number) => [
  {
    id: "00000000-0000-7000-9000-000000000010",
    typeId: null,
    method: "cash" as const,
    amountCents,
    tipCents: 0,
    label: "Cash",
  },
];
const card = (amountCents: number, tipCents = 0) => [
  {
    id: "00000000-0000-7000-9000-000000000011",
    typeId: null,
    method: "card" as const,
    amountCents,
    tipCents,
    label: "Card",
  },
];

let db: RegisterDb;
beforeEach(async () => {
  await Dexie.delete(`tillflow-${ORG}`);
  db = new RegisterDb(ORG);
});

const sell = (tenders: ReturnType<typeof cash> | ReturnType<typeof card>, due = 350) =>
  completeSale(db, {
    registerId: REG,
    cashierUserId: CASHIER,
    cart,
    tenders,
    expectedDueCents: due,
  });

describe("device shift", () => {
  it("stamps sales with the open shift and opens only once", async () => {
    expect(await currentShift(db)).toBeUndefined();
    const a = await openShift(db, { registerId: REG, cashierUserId: CASHIER, floatCents: 10000 });
    const b = await openShift(db, { registerId: REG, cashierUserId: CASHIER, floatCents: 5 });
    expect(b.id).toBe(a.id);
    expect(await db.shiftEvents.count()).toBe(1);
    expect((await sell(cash(500))).shiftId).toBe(a.id);
  });

  it("works out expected cash from sales, cash moves and what was returned", async () => {
    const shift = await openShift(db, {
      registerId: REG,
      cashierUserId: CASHIER,
      floatCents: 10000,
    });
    await sell(cash(500)); // 3.50 due, 5.00 handed over, change given
    await sell(card(350, 50)); // card, tip 0.50
    await addCashMove(db, shift, {
      cashierUserId: CASHIER,
      movement: "in",
      amountCents: 2000,
      note: "bank",
    });
    await addCashMove(db, shift, {
      cashierUserId: CASHIER,
      movement: "out",
      amountCents: 500,
      note: " milk ",
    });
    const s = await summariseShift(db, shift);
    expect(s).toMatchObject({
      saleCount: 2,
      cashSalesCents: 350,
      cardSalesCents: 350,
      tipsCents: 50,
      cashInCents: 2000,
      cashOutCents: 500,
      expectedCents: 10000 + 350 + 2000 - 500,
    });
    expect(
      (await db.shiftEvents.toArray()).find((e) => e.kind === "cash" && e.movement === "out")?.note,
    ).toBe("milk");
  });

  it("refuses bad cash moves and floats", async () => {
    const shift = await openShift(db, { registerId: REG, cashierUserId: CASHIER, floatCents: 0 });
    const move = (amountCents: number, note: string) =>
      addCashMove(db, shift, { cashierUserId: CASHIER, movement: "in", amountCents, note });
    await expect(move(0, "x")).rejects.toThrow();
    await expect(move(100, "  ")).rejects.toThrow();
    await expect(
      openShift(db, { registerId: REG, cashierUserId: CASHIER, floatCents: -1 }),
    ).rejects.toThrow();
  });

  it("closes with over/short, ends the shift and keeps the figures", async () => {
    const shift = await openShift(db, {
      registerId: REG,
      cashierUserId: CASHIER,
      floatCents: 1000,
    });
    await sell(cash(350));
    const z = await closeShift(db, shift, { cashierUserId: CASHIER, countedCents: 1250 });
    expect(z.summary.expectedCents).toBe(1350);
    expect(z.overShortCents).toBe(-100);
    expect(await currentShift(db)).toBeUndefined();
    expect((await db.meta.get("lastClosedShift"))?.value).toMatchObject({ overShortCents: -100 });
    await expect(
      closeShift(db, shift, { cashierUserId: CASHIER, countedCents: 0 }),
    ).rejects.toThrow();
    await expect(
      closeShift(db, { ...shift, id: "nope" }, { cashierUserId: CASHIER, countedCents: -1 }),
    ).rejects.toThrow();
  });
});

describe("outbox order", () => {
  /** A server that records the order it hears things in. */
  function server() {
    const heard: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url.includes("/sync/shifts")) {
        for (const e of body.events) heard.push(e.kind);
        return Response.json({
          results: body.events.map((e: { id: string }) => ({ id: e.id, status: "recorded" })),
        });
      }
      heard.push(...body.sales.map(() => "sale"));
      return Response.json({
        results: body.sales.map((s: { id: string }) => ({ id: s.id, status: "created" })),
      });
    }) as unknown as typeof fetch;
    return { heard, fetchFn };
  }

  it("sends the open before the sales and the close after them", async () => {
    const shift = await openShift(db, { registerId: REG, cashierUserId: CASHIER, floatCents: 0 });
    await sell(cash(350));
    await sell(cash(350));
    await closeShift(db, shift, { cashierUserId: CASHIER, countedCents: 700 });
    const { heard, fetchFn } = server();
    await drainOutbox(db, ORG, { fetchFn, force: true });
    expect(heard).toEqual(["open", "sale", "sale", "close"]);
    expect(await db.shiftEvents.where("syncState").equals("pending").count()).toBe(0);
  });

  it("holds the close while a sale of the shift is still waiting", async () => {
    const shift = await openShift(db, { registerId: REG, cashierUserId: CASHIER, floatCents: 0 });
    await sell(cash(350));
    await closeShift(db, shift, { cashierUserId: CASHIER, countedCents: 350 });
    // Server accepts shift events but the sales call fails: the close must not go.
    const heard: string[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (url.includes("/sync/shifts")) {
        for (const e of body.events) heard.push(e.kind);
        return Response.json({
          results: body.events.map((e: { id: string }) => ({ id: e.id, status: "recorded" })),
        });
      }
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const r = await drainOutbox(db, ORG, { fetchFn, force: true });
    expect(r.state).toBe("backoff");
    expect(heard).toEqual(["open"]);
    expect(
      (await db.shiftEvents.where("syncState").equals("pending").toArray()).map((e) => e.kind),
    ).toEqual(["close"]);
  });

  it("keeps a shift event the server refuses, flagged, and moves on", async () => {
    await openShift(db, { registerId: REG, cashierUserId: CASHIER, floatCents: 0 });
    const fetchFn = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return Response.json({
        results: (body.events ?? []).map((e: { id: string }) => ({ id: e.id, status: "rejected" })),
      });
    }) as unknown as typeof fetch;
    await drainOutbox(db, ORG, { fetchFn, force: true });
    expect((await db.shiftEvents.toArray())[0]!.syncState).toBe("rejected");
  });
});
