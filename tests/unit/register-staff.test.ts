import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hashPin } from "@/lib/auth/pin";
import { RegisterDb } from "@/lib/register/db";
import { LOCK_MS, MAX_FAILURES, checkPin, type StaffMember } from "@/lib/register/staff";

const ORG = "00000000-0000-4000-8000-0000000000f1";
const MGR = "00000000-0000-4000-8000-0000000000a1";
const CSH = "00000000-0000-4000-8000-0000000000a2";

let manager: StaffMember;
let cashier: StaffMember;
beforeAll(async () => {
  manager = { userId: MGR, displayName: "Maeve", role: "manager", pinHash: await hashPin("2580") };
  cashier = { userId: CSH, displayName: "Cian", role: "cashier", pinHash: await hashPin("7391") };
});

let db: RegisterDb;
beforeEach(async () => {
  await Dexie.delete(`tillflow-${ORG}`);
  db = new RegisterDb(ORG);
});

const offline = (async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;
const serverSays = (status: number, body: unknown = {}) =>
  vi.fn(async () => Response.json(body, { status })) as unknown as typeof fetch;

describe("the server-signed serving token", () => {
  it("comes back with an online unlock, and is simply absent offline", async () => {
    const online = (async () =>
      Response.json({ result: "ok", userId: CSH, role: "cashier", servingToken: "payload.sig" })) as unknown as typeof fetch;
    expect(await checkPin(db, cashier, "7391", "unlock", { fetchFn: online })).toMatchObject({
      status: "ok",
      servingToken: "payload.sig",
    });
    const result = await checkPin(db, cashier, "7391", "unlock", { fetchFn: offline });
    expect(result).toMatchObject({ status: "ok" });
    expect(result).not.toHaveProperty("servingToken");
  });
});

describe("a refund approval names its sale and value", () => {
  it("sends the sale and the most it may be spent on with the PIN, only for refunds", async () => {
    const SALE = "00000000-0000-7000-8000-0000000000aa";
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return Response.json({ result: "ok", userId: MGR, role: "manager", approvalId: "ap1" });
    }) as unknown as typeof fetch;
    await checkPin(db, manager, "2580", "override", {
      fetchFn,
      approvalFor: "refund",
      bind: { saleId: SALE, maxCents: 2500 },
    });
    expect(bodies[0]).toMatchObject({ approvalFor: "refund", saleId: SALE, maxCents: 2500 });
    // a discount approval never carries a sale
    await checkPin(db, manager, "2580", "override", {
      fetchFn,
      approvalFor: "discount",
      bind: { saleId: SALE, maxCents: 2500 },
    });
    expect(bodies[1]).not.toHaveProperty("saleId");
    expect(bodies[1]).not.toHaveProperty("maxCents");
  });
});

describe("checkPin offline (cached Argon2 hash)", () => {
  it("accepts the right PIN and clears the failure count", async () => {
    await db.pinAttempts.put({ userId: CSH, failed: 3 });
    expect(await checkPin(db, cashier, "7391", "unlock", { fetchFn: offline })).toEqual({
      status: "ok",
      userId: CSH,
      role: "cashier",
    });
    expect(await db.pinAttempts.get(CSH)).toBeUndefined();
  });

  it("refuses a wrong PIN, and the fifth failure locks for 15 minutes", async () => {
    let t = 1_000_000;
    const now = () => t;
    for (let i = 1; i < MAX_FAILURES; i++) {
      expect(await checkPin(db, cashier, "0000", "unlock", { fetchFn: offline, now })).toEqual({
        status: "invalid",
      });
    }
    const fifth = await checkPin(db, cashier, "0000", "unlock", { fetchFn: offline, now });
    expect(fifth).toEqual({ status: "locked", lockedUntil: t + LOCK_MS });

    // Even the right PIN is refused while locked, without touching the network.
    const fetchFn = vi.fn(offline);
    expect(await checkPin(db, cashier, "7391", "unlock", { fetchFn, now })).toEqual({
      status: "locked",
      lockedUntil: 1_000_000 + LOCK_MS,
    });
    expect(fetchFn).not.toHaveBeenCalled();

    // After the lock runs out the count starts again.
    t += LOCK_MS + 1;
    expect((await checkPin(db, cashier, "7391", "unlock", { fetchFn: offline, now })).status).toBe(
      "ok",
    );
  });

  it("counts the attempt before checking it: a lingering count of 4 gets only one more try", async () => {
    await db.pinAttempts.put({ userId: CSH, failed: MAX_FAILURES - 1 });
    expect((await checkPin(db, cashier, "1111", "unlock", { fetchFn: offline })).status).toBe(
      "locked",
    );
  });

  it("locks one person, not the whole till", async () => {
    for (let i = 0; i < MAX_FAILURES; i++) {
      await checkPin(db, cashier, "0000", "unlock", { fetchFn: offline });
    }
    expect((await checkPin(db, manager, "2580", "unlock", { fetchFn: offline })).status).toBe("ok");
  });

  it("an override needs a manager or owner, even with the right PIN", async () => {
    expect(await checkPin(db, cashier, "7391", "override", { fetchFn: offline })).toEqual({
      status: "not_allowed",
    });
    expect(await checkPin(db, manager, "2580", "override", { fetchFn: offline })).toEqual({
      status: "ok",
      userId: MGR,
      role: "manager",
    });
  });

  it("refuses a hash that is not Argon2 instead of crashing", async () => {
    const odd = { ...cashier, pinHash: "plain-text" };
    expect((await checkPin(db, odd, "7391", "unlock", { fetchFn: offline })).status).toBe(
      "invalid",
    );
  });
});

describe("checkPin online (the server decides)", () => {
  it("passes the server's answers through", async () => {
    expect(
      await checkPin(db, manager, "2580", "unlock", {
        fetchFn: serverSays(200, { result: "ok", userId: MGR, role: "manager" }),
      }),
    ).toEqual({ status: "ok", userId: MGR, role: "manager" });
    expect(
      await checkPin(db, manager, "0000", "unlock", {
        fetchFn: serverSays(200, { result: "invalid" }),
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await checkPin(db, cashier, "7391", "override", {
        fetchFn: serverSays(200, { result: "not_allowed" }),
      }),
    ).toEqual({ status: "not_allowed" });
  });

  it("an override approved online returns the server's proof to attach to the sale", async () => {
    const approvalId = "00000000-0000-4000-8000-0000000000c1";
    const r = await checkPin(db, manager, "2580", "override", {
      fetchFn: serverSays(200, { result: "ok", userId: MGR, role: "manager", approvalId }),
      approvalFor: "discount",
    });
    expect(r).toEqual({ status: "ok", userId: MGR, role: "manager", approvalId });
  });

  it("an override approved offline has no proof: the server will hold the sale", async () => {
    const r = await checkPin(db, manager, "2580", "override", {
      fetchFn: offline,
      approvalFor: "discount",
    });
    expect(r).toEqual({ status: "ok", userId: MGR, role: "manager" });
  });

  it("sends only the person, the PIN and the purpose, with the device cookie", async () => {
    const fetchFn = serverSays(200, { result: "invalid" });
    await checkPin(db, manager, "2580", "override", { fetchFn, approvalFor: "no_sale" });
    const [url, init] = (fetchFn as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]!;
    expect(url).toBe("/api/v1/register/unlock");
    expect(init.credentials).toBe("same-origin");
    expect(JSON.parse(init.body as string)).toEqual({
      userId: MGR,
      pin: "2580",
      purpose: "override",
      approvalFor: "no_sale",
    });
  });

  it("remembers a server lock, so going offline does not buy more guesses", async () => {
    const lockedUntil = new Date(Date.now() + 600_000).toISOString();
    const r = await checkPin(db, cashier, "0000", "unlock", {
      fetchFn: serverSays(200, { result: "locked", lockedUntil }),
    });
    expect(r).toEqual({ status: "locked", lockedUntil: new Date(lockedUntil).getTime() });
    expect((await checkPin(db, cashier, "7391", "unlock", { fetchFn: offline })).status).toBe(
      "locked",
    );
  });

  it("counts server-side failures here too, and locks at five", async () => {
    const fetchFn = serverSays(200, { result: "invalid" });
    for (let i = 1; i < MAX_FAILURES; i++) {
      expect((await checkPin(db, cashier, "0000", "unlock", { fetchFn })).status).toBe("invalid");
    }
    expect((await checkPin(db, cashier, "0000", "unlock", { fetchFn })).status).toBe("locked");
    expect((await checkPin(db, cashier, "7391", "unlock", { fetchFn: offline })).status).toBe(
      "locked",
    );
  });

  it("a revoked till and a rate limit are reported, not swallowed", async () => {
    expect(
      (await checkPin(db, manager, "2580", "unlock", { fetchFn: serverSays(401) })).status,
    ).toBe("unpaired");
    expect(
      (await checkPin(db, manager, "2580", "unlock", { fetchFn: serverSays(429) })).status,
    ).toBe("limited");
  });

  it("a failing server (5xx) or an unreadable answer falls back to the cached hash", async () => {
    expect(
      (await checkPin(db, manager, "2580", "unlock", { fetchFn: serverSays(503) })).status,
    ).toBe("ok");
    expect(
      (
        await checkPin(db, manager, "2580", "unlock", {
          fetchFn: serverSays(200, { result: "something-new" }),
        })
      ).status,
    ).toBe("ok");
  });
});
