import { describe, expect, it, vi } from "vitest";
import { priceCart } from "@/lib/register/cart";
import { buildServerCart, SaleError, type SaleRows } from "@/lib/register/sale-input";
import { MAX_AGE_MS, processBatch, type SyncDeps } from "@/lib/sync/process";
import type { SyncSale } from "@/lib/sync/protocol";
import { IRISH_RATES } from "./money/irish-rates";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const V1 = "00000000-0000-4000-8000-000000000001";
const P1 = "00000000-0000-4000-8000-0000000000a1";
const ctx = {
  orgId: "00000000-0000-4000-8000-0000000000f1",
  registerId: "00000000-0000-4000-8000-0000000000e1",
  userId: "00000000-0000-4000-8000-0000000000d1",
};

const rowsAt = (priceCents: number): SaleRows => ({
  variants: [{ id: V1, productId: P1, name: "", priceCents, attributes: {} }],
  products: [{ id: P1, name: "Tea bags", taxCategory: "STANDARD", takeawayTaxCategory: null }],
  modifiers: [],
  productGroups: [],
});

let n = 0;
const sale = (over: Partial<SyncSale> = {}): SyncSale => ({
  id: `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  receiptSeq: n,
  completedAt: NOW.toISOString(),
  mode: "eat_in",
  lines: [{ variantId: V1, qty: 1, modifierIds: [] }],
  tenderedCents: 2000,
  expectedDueCents: 1235, // €12.34 rounds to €12.35 for cash
  ...over,
});

/** A server whose catalogue price depends on the moment asked about. */
function deps(priceAt: (at: Date) => number | "unknown", over: Partial<SyncDeps> = {}) {
  const recorded: unknown[] = [];
  const rejections: Record<string, unknown>[] = [];
  const d: SyncDeps = {
    now: () => NOW,
    existingIds: async () => new Set(),
    priceAt: async (s, at) => {
      const price = priceAt(at);
      if (price === "unknown") throw new SaleError("unknown item");
      const cart = buildServerCart(s, rowsAt(price));
      return {
        cart,
        priced: priceCart(cart, { country: "IE", date: "2026-10-06", rates: IRISH_RATES }),
      };
    },
    recordSale: async (p) => {
      recorded.push(p);
      return "created";
    },
    recordRejection: async (p) => {
      rejections.push(p as Record<string, unknown>);
    },
    ...over,
  };
  return { d, recorded, rejections };
}

describe("processBatch", () => {
  it("records a matching sale with its VAT snapshot", async () => {
    const { d, recorded } = deps(() => 1234);
    const [r] = await processBatch([sale()], ctx, d);
    expect(r).toMatchObject({ status: "created" });
    const rec = recorded[0] as { sale: Record<string, number>; lines: Record<string, unknown>[] };
    expect(rec.sale).toMatchObject({ amount_due: 1235, client_due: 1235, cash_rounding: 1 });
    expect(rec.lines[0]).toMatchObject({ tax_rate_bp: 2300, gross_cents: 1234 });
  });

  it("answers duplicate for a sale already on the server, even if prices have moved since", async () => {
    const s = sale();
    const { d, recorded } = deps(() => 9999, { existingIds: async () => new Set([s.id]) });
    expect(await processBatch([s], ctx, d)).toEqual([{ id: s.id, status: "duplicate" }]);
    expect(recorded).toHaveLength(0);
  });

  it("passes a duplicate reported by the database through", async () => {
    const { d } = deps(() => 1234, { recordSale: async () => "duplicate" });
    const [r] = await processBatch([sale()], ctx, d);
    expect(r!.status).toBe("duplicate");
  });

  it("rejects a malformed sale alone; the others still go through", async () => {
    const good = sale();
    const bad = { ...sale(), tenderedCents: -5 };
    const { d, recorded, rejections } = deps(() => 1234);
    const results = await processBatch([bad, good], ctx, d);
    expect(results.map((r) => r.status)).toEqual(["rejected", "created"]);
    expect(results[0]!.reason).toBe("invalid");
    expect(recorded).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ id: bad.id, reason: "invalid" });
  });

  it("an unreadable item without a usable id is rejected without a database write", async () => {
    const { d, rejections } = deps(() => 1234);
    const [r] = await processBatch([{ nonsense: true }], ctx, d);
    expect(r).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(rejections).toHaveLength(0);
  });

  it("accepts a total 1c off and rejects 2c off", async () => {
    const { d, recorded } = deps(() => 1234);
    const ok = await processBatch([sale({ expectedDueCents: 1236 })], ctx, d);
    expect(ok[0]!.status).toBe("created");
    const x = deps(() => 1234);
    const bad = await processBatch([sale({ expectedDueCents: 1237 })], ctx, x.d);
    expect(bad[0]).toMatchObject({ status: "rejected", reason: "price_mismatch" });
    expect(x.rejections[0]!.detail).toEqual({ tillDueCents: 1237, serverDueCents: 1235 });
    expect(recorded).toHaveLength(1);
  });

  it("prices at the catalogue the till had when the price changed after the sale", async () => {
    // Price moved to 1500 an hour before completion, but the till last pulled before that.
    const pulled = new Date(NOW.getTime() - 2 * 3_600_000);
    const change = new Date(NOW.getTime() - 3_600_000);
    const { d, recorded } = deps((at) => (at < change ? 1234 : 1500));
    const s = sale({ catalogAsOf: pulled.toISOString() });
    const [r] = await processBatch([s], ctx, d);
    expect(r!.status).toBe("created");
    expect((recorded[0] as { sale: { priced_as_of: string } }).sale.priced_as_of).toBe(
      pulled.toISOString(),
    );
  });

  it("ignores a catalogAsOf after the sale or older than 30 days", async () => {
    const { d } = deps((at) => (at.getTime() === NOW.getTime() ? 1500 : 1234));
    const later = sale({ catalogAsOf: new Date(NOW.getTime() + 60_000).toISOString() });
    const old = sale({ catalogAsOf: new Date(NOW.getTime() - 31 * 86_400_000).toISOString() });
    const results = await processBatch([later, old], ctx, d);
    expect(results.map((r) => r.reason)).toEqual(["price_mismatch", "price_mismatch"]);
  });

  it("falls back to the current catalogue for a product created just before the sale", async () => {
    const { d } = deps((at) => (at < NOW ? "unknown" : 1234));
    const [r] = await processBatch([sale()], ctx, d);
    expect(r!.status).toBe("created");
  });

  it("maps pricing failures to reasons", async () => {
    const throwing = (message: string) =>
      deps(() => 1, {
        priceAt: async () => {
          throw new SaleError(message);
        },
      }).d;
    const reason = async (m: string) => (await processBatch([sale()], ctx, throwing(m)))[0]!.reason;
    expect(await reason("unknown item")).toBe("unknown_item");
    expect(await reason("modifier not offered")).toBe("modifier_not_offered");
    expect(await reason("duplicate modifier")).toBe("modifier_not_offered");
    expect(await reason("cannot price")).toBe("cannot_price");
    expect(await reason("negative price")).toBe("cannot_price");
  });

  it("rejects cash that does not cover the amount due", async () => {
    const { d, recorded } = deps(() => 1234);
    const [r] = await processBatch([sale({ tenderedCents: 1000 })], ctx, d);
    expect(r).toMatchObject({ status: "rejected", reason: "short_tender" });
    expect(recorded).toHaveLength(0);
  });

  it("bounds the device clock: not older than 90 days, not in the future", async () => {
    const { d } = deps(() => 1234);
    const old = sale({ completedAt: new Date(NOW.getTime() - MAX_AGE_MS - 1000).toISOString() });
    const future = sale({ completedAt: new Date(NOW.getTime() + 11 * 60_000).toISOString() });
    const edge = sale({ completedAt: new Date(NOW.getTime() + 5 * 60_000).toISOString() });
    const results = await processBatch([old, future, edge], ctx, d);
    expect(results.map((r) => r.reason ?? r.status)).toEqual(["bad_time", "bad_time", "created"]);
  });

  it("turns a receipt number clash into a rejection", async () => {
    const { d, rejections } = deps(() => 1234, { recordSale: async () => "receipt_clash" });
    const [r] = await processBatch([sale()], ctx, d);
    expect(r).toMatchObject({ status: "rejected", reason: "receipt_number_used" });
    expect(rejections).toHaveLength(1);
  });

  it("keeps the cart inputs and the cashier on a rejection, nothing else", async () => {
    const { d, rejections } = deps(() => 1234);
    const s = sale({ expectedDueCents: 5 });
    await processBatch([s], ctx, d);
    const payload = rejections[0]!.payload as Record<string, unknown>;
    expect(payload).toEqual({ ...s, cashierUserId: ctx.userId });
    expect(rejections[0]).toMatchObject({ org_id: ctx.orgId, register_id: ctx.registerId });
  });

  it("lets a database failure through so the device retries (nothing is half-recorded)", async () => {
    const boom = deps(() => 1234, {
      priceAt: async () => {
        throw new Error("connection reset");
      },
    }).d;
    await expect(processBatch([sale()], ctx, boom)).rejects.toThrow("connection reset");
    const writeFails = deps(() => 1234, {
      recordSale: vi.fn().mockRejectedValue(new Error("db down")),
    }).d;
    await expect(processBatch([sale()], ctx, writeFails)).rejects.toThrow("db down");
  });

  it("processes sales in the order given", async () => {
    const order: string[] = [];
    const { d } = deps(() => 1234, {
      recordSale: async (p) => {
        order.push((p as { sale: { id: string } }).sale.id);
        return "created";
      },
    });
    const a = sale();
    const b = sale();
    const c = sale();
    await processBatch([a, b, c], ctx, d);
    expect(order).toEqual([a.id, b.id, c.id]);
  });
});

describe("hostile ids and payloads", () => {
  it("an id that only looks like a UUID is rejected without touching the database", async () => {
    const existingIds = vi.fn(async () => new Set<string>());
    const { d, rejections } = deps(() => 1234, { existingIds });
    const bad = { ...sale(), id: "a".repeat(36) };
    const results = await processBatch([bad, sale()], ctx, d);
    expect(results[0]).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(results[1]!.status).toBe("created");
    expect(rejections).toHaveLength(0);
    expect(existingIds).toHaveBeenCalledWith([expect.not.stringMatching(/^a{36}$/)]);
  });

  it("a rejected sale too big to store keeps only its identity", async () => {
    const { d, rejections } = deps(() => 1234);
    const lines = Array.from({ length: 100 }, () => ({
      variantId: V1,
      qty: 1,
      modifierIds: Array.from({ length: 30 }, () => "00000000-0000-4000-8000-0000000000aa"),
    }));
    await processBatch([sale({ lines, expectedDueCents: 1 })], ctx, d);
    expect(rejections[0]!.payload).toMatchObject({ truncated: true });
  });
});
