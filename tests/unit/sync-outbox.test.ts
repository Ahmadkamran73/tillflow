import "fake-indexeddb/auto";
import Dexie from "dexie";
import { v7 as uuidv7 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Cart } from "@/lib/register/cart";
import { RegisterDb } from "@/lib/register/db";
import { completeSale } from "@/lib/register/sale";
import {
  backoffDelay,
  drainOutbox,
  heartbeat,
  KEEP_SYNCED_MS,
  pendingSales,
} from "@/lib/sync/outbox";

const ORG = "00000000-0000-4000-8000-0000000000f1";
const REG = "00000000-0000-4000-8000-0000000000e1";
const V1 = "00000000-0000-4000-8000-000000000001";

const cart: Cart = {
  ageChecked: true,
  lines: [
    {
      id: "0",
      variantId: V1,
      productId: "p",
      name: "Tea bags",
      unitPriceCents: 1234,
      modifiers: [],
      qty: 1,
      taxCategory: "STANDARD",
      takeawayTaxCategory: null,
      depositCents: 0,
    },
  ],
};

let db: RegisterDb;
beforeEach(async () => {
  await Dexie.delete(`tillflow-${ORG}`);
  db = new RegisterDb(ORG);
});

const CASHIER = "00000000-0000-4000-8000-0000000000d1";

const sell = (n = 1) =>
  Promise.all(
    Array.from({ length: n }, () =>
      completeSale(db, { registerId: REG, cashierUserId: CASHIER, cart, tenderedCents: 2000, expectedDueCents: 1235 }),
    ),
  );

type Call = { sales: { id: string }[] };

/** A server that answers each batch with the given status per sale. */
function server(answer: (id: string) => "created" | "duplicate" | "rejected" = () => "created") {
  const calls: Call[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as Call;
    calls.push(body);
    return Response.json({
      results: body.sales.map((s) => {
        const status = answer(s.id);
        return status === "rejected"
          ? { id: s.id, status, reason: "price_mismatch" }
          : { id: s.id, status };
      }),
    });
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

const states = async () => (await db.sales.orderBy("id").toArray()).map((s) => s.syncState);

describe("completeSale (the outbox write)", () => {
  it("saves a pending sale with a UUIDv7 id and the figures the server will check", async () => {
    const [s] = await sell();
    expect(s).toMatchObject({ syncState: "pending", expectedDueCents: 1235, receiptSeq: 1 });
    expect(s!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    expect(await db.sales.count()).toBe(1);
  });

  it("numbers sales one after another, and carries on after the server's last number", async () => {
    await db.meta.put({
      key: "registers",
      value: [{ id: REG, name: "Till 1", lastSeq: 40 }],
    });
    await db.meta.put({ key: "pulledAt", value: "2026-10-06T11:00:00.000Z" });
    const a = await completeSale(db, {
      cashierUserId: CASHIER,
      registerId: REG,
      cart,
      tenderedCents: 2000,
      expectedDueCents: 1,
    });
    const b = await completeSale(db, {
      cashierUserId: CASHIER,
      registerId: REG,
      cart,
      tenderedCents: 2000,
      expectedDueCents: 1,
    });
    expect([a.receiptSeq, b.receiptSeq]).toEqual([41, 42]);
    expect(a.catalogAsOf).toBe("2026-10-06T11:00:00.000Z");
  });
});

describe("drainOutbox", () => {
  it("sends oldest first, in batches, and marks sales synced only after the server says so", async () => {
    // Real UUIDv7 ids are minted a moment apart, so insertion order is id order.
    for (let i = 0; i < 30; i++) {
      await completeSale(db, {
        cashierUserId: CASHIER,
        registerId: REG,
        cart,
        tenderedCents: 2000,
        expectedDueCents: 1235,
      });
      await new Promise((r) => setTimeout(r, 1));
    }
    const s = server();
    const res = await drainOutbox(db, ORG, { fetchFn: s.fetchFn });
    expect(res).toEqual({ state: "idle", sent: 30 });
    expect(s.calls.map((c) => c.sales.length)).toEqual([25, 5]);
    const sent = s.calls.flatMap((c) => c.sales.map((x) => x.id));
    expect(sent).toEqual([...sent].sort());
    expect((await states()).every((x) => x === "synced")).toBe(true);
  });

  it("keeps every sale and backs off when the network fails; resumes when it returns", async () => {
    await sell(3);
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const t = 1_000_000;
    const first = await drainOutbox(db, ORG, { fetchFn: down, now: () => t, random: () => 1 });
    expect(first.state).toBe("backoff");
    expect(await states()).toEqual(["pending", "pending", "pending"]);

    // Inside the backoff window nothing is attempted...
    const s = server();
    expect((await drainOutbox(db, ORG, { fetchFn: s.fetchFn, now: () => t + 100 })).state).toBe(
      "backoff",
    );
    expect(s.calls).toHaveLength(0);
    // ...unless forced (the network just came back).
    const res = await drainOutbox(db, ORG, { fetchFn: s.fetchFn, now: () => t + 100, force: true });
    expect(res).toEqual({ state: "idle", sent: 3 });
    expect(await db.meta.get("syncBackoff")).toBeUndefined();
    expect(await db.meta.get("lastContactAt")).toBeDefined();
  });

  it("treats a 5xx like a network failure: nothing is marked, nothing is lost", async () => {
    await sell(2);
    const broken = (async () => new Response("{}", { status: 503 })) as unknown as typeof fetch;
    expect((await drainOutbox(db, ORG, { fetchFn: broken })).state).toBe("backoff");
    expect(await states()).toEqual(["pending", "pending"]);
    const garbled = (async () => new Response("<html>")) as unknown as typeof fetch;
    expect((await drainOutbox(db, ORG, { fetchFn: garbled, force: true })).state).toBe("backoff");
    expect(await states()).toEqual(["pending", "pending"]);
  });

  it("a sale the server answered nothing about stays pending", async () => {
    await sell(2);
    const partial = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Call;
      return Response.json({ results: [{ id: body.sales[0]!.id, status: "created" }] });
    }) as unknown as typeof fetch;
    const res = await drainOutbox(db, ORG, { fetchFn: partial });
    expect(res).toEqual({ state: "backoff", sent: 1 });
    expect((await states()).filter((x) => x === "pending")).toHaveLength(1);
  });

  it("a rejected sale is flagged and the queue moves on", async () => {
    for (let i = 0; i < 3; i++) {
      await completeSale(db, {
        cashierUserId: CASHIER,
        registerId: REG,
        cart,
        tenderedCents: 2000,
        expectedDueCents: 1235,
      });
      await new Promise((r) => setTimeout(r, 1));
    }
    const all = await db.sales.orderBy("id").toArray();
    const s = server((id) => (id === all[1]!.id ? "rejected" : "created"));
    expect(await drainOutbox(db, ORG, { fetchFn: s.fetchFn })).toEqual({ state: "idle", sent: 3 });
    expect(await states()).toEqual(["synced", "rejected", "synced"]);
    expect((await db.sales.get(all[1]!.id))!.rejectReason).toBe("price_mismatch");
    // The rejected sale is kept, never deleted.
    expect(await db.sales.count()).toBe(3);
  });

  it("duplicate counts as confirmed", async () => {
    await sell(1);
    const s = server(() => "duplicate");
    await drainOutbox(db, ORG, { fetchFn: s.fetchFn });
    expect(await states()).toEqual(["synced"]);
  });

  it("stops on 401/403 and keeps the sales", async () => {
    await sell(2);
    for (const status of [401, 403]) {
      const out = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      expect(await drainOutbox(db, ORG, { fetchFn: out, force: true })).toEqual({
        state: "signed-out",
        sent: 0,
      });
    }
    expect(await states()).toEqual(["pending", "pending"]);
  });

  it("splits a batch the server calls too big, and keeps a single refused sale pending", async () => {
    for (let i = 0; i < 4; i++) {
      await completeSale(db, {
        cashierUserId: CASHIER,
        registerId: REG,
        cart,
        tenderedCents: 2000,
        expectedDueCents: 1235,
      });
      await new Promise((r) => setTimeout(r, 1));
    }
    const sizes: number[] = [];
    const picky = (async (_u: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as Call;
      sizes.push(body.sales.length);
      return new Response("{}", { status: body.sales.length > 1 ? 413 : 400 });
    }) as unknown as typeof fetch;
    const res = await drainOutbox(db, ORG, { fetchFn: picky });
    expect(res.state).toBe("backoff");
    expect(sizes[0]).toBe(4);
    expect(sizes.at(-1)).toBe(1);
    // The server never judged these sales, so none is marked rejected and none is lost.
    expect(await states()).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("two overlapping drains leave every sale synced", async () => {
    await sell(2);
    const s = server();
    const [x, y] = await Promise.all([
      drainOutbox(db, ORG, { fetchFn: s.fetchFn }),
      drainOutbox(db, ORG, { fetchFn: s.fetchFn }),
    ]);
    expect(x.state === "idle" || y.state === "idle").toBe(true);
    expect(await states()).toEqual(["synced", "synced"]);
  });

  it("sends the cart inputs only, never a price or a total", async () => {
    await sell(1);
    let body = "";
    const spy = (async (_u: string, init: RequestInit) => {
      body = init.body as string;
      return Response.json({ results: [] });
    }) as unknown as typeof fetch;
    await drainOutbox(db, ORG, { fetchFn: spy });
    const sale = (JSON.parse(body) as { sales: Record<string, unknown>[] }).sales[0]!;
    expect(Object.keys(sale).sort()).toEqual(
      [
        "cashierUserId",
        "completedAt",
        "expectedDueCents",
        "id",
        "lines",
        "mode",
        "receiptSeq",
        "tenderedCents",
      ].sort(),
    );
    expect(sale.lines).toEqual([{ variantId: V1, qty: 1, modifierIds: [] }]);
  });

  it("drops synced sales after 30 days, never pending or rejected ones", async () => {
    const old = uuidv7();
    const base = await completeSale(db, {
      cashierUserId: CASHIER,
      registerId: REG,
      cart,
      tenderedCents: 2000,
      expectedDueCents: 1,
    });
    await db.sales.bulkAdd([
      { ...base, id: old, syncState: "synced", syncedAt: 1 },
      { ...base, id: uuidv7(), receiptSeq: 99, syncState: "rejected" },
    ]);
    // Drain with a clock far in the future: only the old synced row goes.
    const s = server();
    await drainOutbox(db, ORG, { fetchFn: s.fetchFn, now: () => KEEP_SYNCED_MS + 10 });
    expect(await db.sales.get(old)).toBeUndefined();
    expect((await db.sales.toArray()).map((x) => x.syncState).sort()).toEqual([
      "rejected",
      "synced",
    ]);
  });
});

describe("backoffDelay and heartbeat", () => {
  it("doubles from 2s, caps at 5 minutes and keeps between half and all of it", () => {
    expect(backoffDelay(1, () => 1)).toBe(2000);
    expect(backoffDelay(2, () => 1)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(300_000);
    expect(backoffDelay(3, () => 0)).toBe(4000);
  });

  it("an empty batch records contact when the server answers", async () => {
    const ok = (async () => Response.json({ results: [] })) as unknown as typeof fetch;
    expect(await heartbeat(db, ORG, REG, ok)).toBe(true);
    expect(await db.meta.get("lastContactAt")).toBeDefined();
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect(await heartbeat(db, ORG, REG, down)).toBe(false);
  });
});

describe("Dexie upgrade from v2", () => {
  it("queues sales made before sync existed, with their expected total", async () => {
    const name = "tillflow-upgrade-test";
    await Dexie.delete(name);
    const v2 = new Dexie(name);
    v2.version(1).stores({
      products: "id",
      variants: "id, productId, barcode",
      categories: "id",
      modifierGroups: "id",
      modifiers: "id, groupId",
      productGroups: "id, productId",
      meta: "key",
      parked: "id, savedAt",
    });
    v2.version(2).stores({ sales: "id, completedAt" });
    await v2.table("meta").bulkPut([
      { key: "org", value: { country: "IE", timezone: "Europe/Dublin" } },
      {
        key: "taxRates",
        value: [
          { country: "IE", code: "STANDARD", rateBp: 2300, validFrom: "2024-01-01", validTo: null },
        ],
      },
    ]);
    await v2.table("sales").add({
      id: uuidv7(),
      registerId: REG,
      receiptSeq: 1,
      completedAt: "2026-10-05T10:00:00.000Z",
      cart,
      tenderedCents: 2000,
    });
    v2.close();

    const upgraded = new RegisterDb(name.replace("tillflow-", ""));
    const rows = await upgraded.sales.toArray();
    expect(rows[0]).toMatchObject({ syncState: "pending", attempts: 0, expectedDueCents: 1235 });
    expect(await pendingSales(upgraded)).toHaveLength(1);
    upgraded.close();
    await Dexie.delete(name);
  });
});

describe("register events outbox", () => {
  const event = (over: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    kind: "no_sale" as const,
    at: new Date().toISOString(),
    cashierUserId: CASHIER,
    approvalId: "00000000-0000-4000-8000-0000000000c1",
    detail: {},
    syncState: "pending" as const,
    ...over,
  });
  const answer = (status: number, results: unknown[] = []) =>
    vi.fn(async (url: string) =>
      url.includes("/events")
        ? Response.json({ results }, { status })
        : Response.json({ results: [] }),
    ) as unknown as typeof fetch;

  it("sends queued events after the sales and removes the recorded ones", async () => {
    const a = event();
    const b = event();
    await db.events.bulkAdd([a, b]);
    const fetchFn = answer(200, [
      { id: a.id, status: "recorded" },
      { id: b.id, status: "recorded" },
    ]);
    expect((await drainOutbox(db, ORG, { fetchFn })).state).toBe("idle");
    expect(await db.events.count()).toBe(0);
    const [, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    const wire = (JSON.parse(init.body as string) as { events: Record<string, unknown>[] }).events;
    expect(Object.keys(wire[0]!).sort()).toEqual(
      ["approvalId", "at", "cashierUserId", "detail", "id", "kind"].sort(),
    );
  });

  it("keeps a rejected event flagged and does not send it again", async () => {
    const a = event();
    await db.events.add(a);
    await drainOutbox(db, ORG, { fetchFn: answer(200, [{ id: a.id, status: "rejected" }]) });
    expect((await db.events.get(a.id))?.syncState).toBe("rejected");
    const again = answer(200);
    await drainOutbox(db, ORG, { fetchFn: again, force: true });
    expect(again).not.toHaveBeenCalled();
  });

  it("keeps everything and backs off when the server cannot be reached or fails", async () => {
    const a = event();
    await db.events.add(a);
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect((await drainOutbox(db, ORG, { fetchFn: down })).state).toBe("backoff");
    expect((await drainOutbox(db, ORG, { fetchFn: answer(503), force: true })).state).toBe(
      "backoff",
    );
    expect((await db.events.get(a.id))?.syncState).toBe("pending");
  });

  it("an unpaired till is reported and its events stay queued", async () => {
    const a = event();
    await db.events.add(a);
    expect((await drainOutbox(db, ORG, { fetchFn: answer(401) })).state).toBe("signed-out");
    expect(await db.events.count()).toBe(1);
  });
});
