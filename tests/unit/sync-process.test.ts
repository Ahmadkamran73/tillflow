import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
  discountOverrideBp: 1000,
};
const CASHIER = "00000000-0000-4000-8000-0000000000d1";
const MANAGER = "00000000-0000-4000-8000-0000000000d2";

const rowsAt = (priceCents: number): SaleRows => ({
  variants: [{ id: V1, productId: P1, name: "", priceCents, attributes: {} }],
  products: [{ id: P1, name: "Tea bags", taxCategory: "STANDARD", takeawayTaxCategory: null }],
  modifiers: [],
  productGroups: [],
});

let n = 0;
const sale = (over: Partial<SyncSale> = {}): SyncSale => ({
  id: `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
  cashierUserId: CASHIER,
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
    expect(payload).toEqual({ ...s });
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

describe("errors that would repeat forever", () => {
  it("a constraint or permission error from the database becomes a rejection, not a retry", async () => {
    for (const code of ["23505", "23514", "22P02", "42501"]) {
      const { d, rejections } = deps(() => 1234, {
        recordSale: async () => {
          throw Object.assign(new Error("db"), { code });
        },
      });
      const [r] = await processBatch([sale()], ctx, d);
      expect(r).toMatchObject({ status: "rejected", reason: "invalid" });
      expect(rejections).toHaveLength(1);
    }
  });

  it("a connection error still throws so the device retries", async () => {
    const { d } = deps(() => 1234, {
      recordSale: async () => {
        throw Object.assign(new Error("db"), { code: "ECONNRESET" });
      },
    });
    await expect(processBatch([sale()], ctx, d)).rejects.toThrow("db");
  });

  it("an unreadable catalogue row becomes a rejection", async () => {
    const { d } = deps(() => 1234, {
      priceAt: async () => {
        throw new z.ZodError([]);
      },
    });
    const [r] = await processBatch([sale()], ctx, d);
    expect(r).toMatchObject({ status: "rejected", reason: "cannot_price" });
  });

  it("an invalid sale keeps what the till sent", async () => {
    const { d, rejections } = deps(() => 1234);
    const bad = { ...sale(), tenderedCents: -1 };
    await processBatch([bad], ctx, d);
    expect(rejections[0]!.payload).toMatchObject({ invalid: true, raw: { raw: { id: bad.id } } });
  });
});

describe("manager override and cashier attribution (step 1.7)", () => {
  /** A sale of the €12.34 item with a line discount, priced the way the server will price it. */
  const discounted = (percentBp: number, over: Partial<SyncSale> = {}) => {
    const base = sale({
      lines: [{ variantId: V1, qty: 1, modifierIds: [], discount: { percentBp } }],
      ...over,
    });
    const cart = buildServerCart(base, rowsAt(1234));
    const due = priceCart(cart, { country: "IE", date: "2026-10-06", rates: IRISH_RATES }).basket
      .amountDue;
    return { ...base, expectedDueCents: due, tenderedCents: 5000 };
  };

  it("records the sale under the cashier who rang it up", async () => {
    const { d, recorded } = deps(() => 1234);
    await processBatch([sale()], ctx, d);
    expect((recorded[0] as { sale: Record<string, unknown> }).sale.user_id).toBe(CASHIER);
  });

  it("a discount at the shop's limit needs no approval", async () => {
    const { d, recorded } = deps(() => 1234);
    const [r] = await processBatch([discounted(1000)], ctx, d);
    expect(r!.status).toBe("created");
    expect((recorded[0] as { sale: Record<string, unknown> }).sale.approved_by).toBeNull();
  });

  it("a discount above the limit without a manager's approval is held for a manager", async () => {
    const { d, recorded, rejections } = deps(() => 1234);
    const s = discounted(2500);
    const [r] = await processBatch([s], ctx, d);
    expect(r).toEqual({ id: s.id, status: "rejected", reason: "discount_needs_approval" });
    expect(recorded).toHaveLength(0);
    expect(rejections[0]).toMatchObject({
      reason: "discount_needs_approval",
      user_id: CASHIER,
      detail: { thresholdBp: 1000 },
    });
    // Nothing about the cart is lost: Try again can re-run exactly this sale.
    expect(rejections[0]!.payload).toEqual(s);
  });

  const APPROVAL = "00000000-0000-4000-8000-0000000000c1";

  it("a till's approval id goes to the database, which derives the approver from it", async () => {
    const { d, recorded } = deps(() => 1234);
    const [r] = await processBatch([discounted(2500, { approvalId: APPROVAL })], ctx, d);
    expect(r!.status).toBe("created");
    const rec = (recorded[0] as { sale: Record<string, unknown> }).sale;
    expect(rec.approval_id).toBe(APPROVAL);
    expect(rec.approved_by).toBeNull(); // a till can never name the approver
  });

  it("a till cannot name an approver at all: the old field is refused", async () => {
    const { d, recorded } = deps(() => 1234);
    const forged = { ...discounted(2500), approvedBy: MANAGER };
    const [r] = await processBatch([forged], ctx, d);
    expect(r).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(recorded).toHaveLength(0);
  });

  it("the back office re-running a held sale is the manager's own approval (trusted context)", async () => {
    const { d, recorded } = deps(() => 1234);
    const [r] = await processBatch([discounted(2500)], { ...ctx, approverUserId: MANAGER }, d);
    expect(r!.status).toBe("created");
    const rec = (recorded[0] as { sale: Record<string, unknown> }).sale;
    expect(rec.approved_by).toBe(MANAGER);
    expect(rec.approval_id).toBeNull();
  });

  it("an approval nobody needed is not recorded as an override", async () => {
    const { d, recorded } = deps(() => 1234);
    await processBatch([sale({ approvalId: APPROVAL })], { ...ctx, approverUserId: MANAGER }, d);
    const rec = (recorded[0] as { sale: Record<string, unknown> }).sale;
    expect(rec.approval_id).toBeNull();
    expect(rec.approved_by).toBeNull();
  });

  it("the shop's limit is the one on the server, not anything the till says", async () => {
    const { d } = deps(() => 1234);
    const strict = { ...ctx, discountOverrideBp: 0 };
    const [r] = await processBatch([discounted(500)], strict, d);
    expect(r!.reason).toBe("discount_needs_approval");
    const lax = { ...ctx, discountOverrideBp: 10_000 };
    expect((await processBatch([discounted(9000)], lax, d))[0]!.status).toBe("created");
  });

  it("an approval the database refuses (spent, expired, another till's, forged) holds the sale for a manager", async () => {
    const { d, rejections } = deps(() => 1234, {
      recordSale: async () => {
        throw Object.assign(new Error("approval not valid"), { code: "42501" });
      },
    });
    const [r] = await processBatch([discounted(2500, { approvalId: APPROVAL })], ctx, d);
    expect(r).toMatchObject({ status: "rejected", reason: "discount_needs_approval" });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.detail).toMatchObject({ approval: "not valid" });
  });

  it("any other permission failure is still just invalid, not a discount hold", async () => {
    const { d } = deps(() => 1234, {
      recordSale: async () => {
        throw Object.assign(new Error("not a member"), { code: "42501" });
      },
    });
    const [r] = await processBatch([sale()], ctx, d);
    expect(r).toMatchObject({ status: "rejected", reason: "invalid" });
  });

  it("an unreadable sale is rejected under the cashier it names, if it names a real one", async () => {
    const { d, rejections } = deps(() => 1234);
    const named = { ...sale(), tenderedCents: -5 };
    const nameless = { ...sale(), tenderedCents: -5, cashierUserId: "nobody" };
    await processBatch([named, nameless], ctx, d);
    expect(rejections[0]!.user_id).toBe(CASHIER);
    expect(rejections[1]!.user_id).toBeNull();
  });
});

describe("review flags (saved, but worth a manager's look)", () => {
  const flagsOf = (recorded: unknown[]) =>
    (recorded[0] as { sale: { review_flags: string[]; client_vat: number | null } }).sale;

  it("a sale whose till VAT matches has no flags; the till's VAT is stored", async () => {
    const { d, recorded } = deps(() => 1234);
    // €12.34 at 23%: VAT 231c.
    await processBatch([sale({ expectedVatCents: 231 })], ctx, d);
    expect(flagsOf(recorded)).toMatchObject({ review_flags: [], client_vat: 231 });
  });

  it("a VAT difference over 1c is saved and flagged, not rejected", async () => {
    const { d, recorded, rejections } = deps(() => 1234);
    const [r] = await processBatch([sale({ expectedVatCents: 200 })], ctx, d);
    expect(r!.status).toBe("created");
    expect(rejections).toHaveLength(0);
    expect(flagsOf(recorded).review_flags).toEqual(["vat_differs"]);
  });

  it("an older till that sends no VAT is not flagged", async () => {
    const { d, recorded } = deps(() => 1234);
    await processBatch([sale()], ctx, d);
    expect(flagsOf(recorded)).toMatchObject({ review_flags: [], client_vat: null });
  });

  it("a late sale priced at an older, cheaper catalogue is flagged old_prices", async () => {
    // Rung up two days ago at €12.34; the price rose to €15.00 yesterday.
    const completed = new Date(NOW.getTime() - 2 * 86_400_000);
    const rise = new Date(NOW.getTime() - 86_400_000);
    const { d, recorded } = deps((at) => (at < rise ? 1234 : 1500));
    const [r] = await processBatch([sale({ completedAt: completed.toISOString() })], ctx, d);
    expect(r!.status).toBe("created");
    expect(flagsOf(recorded).review_flags).toEqual(["old_prices"]);
  });

  it("a late sale whose price has not risen since is not flagged", async () => {
    const completed = new Date(NOW.getTime() - 2 * 86_400_000);
    const { d, recorded } = deps(() => 1234);
    await processBatch([sale({ completedAt: completed.toISOString() })], ctx, d);
    expect(flagsOf(recorded).review_flags).toEqual([]);
  });

  it("a sale synced within the hour is never re-priced at today's catalogue", async () => {
    const completed = new Date(NOW.getTime() - 30 * 60_000);
    const asked: Date[] = [];
    const { d, recorded } = deps((at) => {
      asked.push(at);
      return at < NOW ? 1234 : 1500;
    });
    await processBatch([sale({ completedAt: completed.toISOString() })], ctx, d);
    expect(flagsOf(recorded).review_flags).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it("a product removed since is not flagged (it cannot be priced today)", async () => {
    const completed = new Date(NOW.getTime() - 2 * 86_400_000);
    const { d, recorded } = deps((at) => (at < NOW ? 1234 : "unknown"));
    await processBatch([sale({ completedAt: completed.toISOString() })], ctx, d);
    expect(flagsOf(recorded).review_flags).toEqual([]);
  });

  it("both flags can apply to one sale", async () => {
    const completed = new Date(NOW.getTime() - 2 * 86_400_000);
    const { d, recorded } = deps((at) => (at < NOW ? 1234 : 1500));
    await processBatch(
      [sale({ completedAt: completed.toISOString(), expectedVatCents: 100 })],
      ctx,
      d,
    );
    expect(flagsOf(recorded).review_flags).toEqual(["vat_differs", "old_prices"]);
  });
});

describe("review flags after the VAT audit", () => {
  const recordOf = (recorded: unknown[]) =>
    (recorded[0] as { sale: { review_flags: string[]; vat: number; priced_as_of: string } }).sale;

  it("a till that stopped pulling the catalogue is flagged even when it syncs at once", async () => {
    // Pulled five days ago at €12.34; the price rose to €15.00 since; sold ten minutes ago.
    const pulled = new Date(NOW.getTime() - 5 * 86_400_000);
    const rise = new Date(NOW.getTime() - 86_400_000);
    const completed = new Date(NOW.getTime() - 10 * 60_000);
    const { d, recorded } = deps((at) => (at < rise ? 1234 : 1500));
    const [r] = await processBatch(
      [sale({ completedAt: completed.toISOString(), catalogAsOf: pulled.toISOString() })],
      ctx,
      d,
    );
    expect(r!.status).toBe("created");
    expect(recordOf(recorded).review_flags).toEqual(["old_prices"]);
  });

  it("prefers the catalogue moment that also gives the VAT the receipt printed", async () => {
    // Same €12.34 price throughout, but the product moved from 9% to 23% after the till's pull.
    const pulled = new Date(NOW.getTime() - 86_400_000);
    const change = new Date(NOW.getTime() - 3_600_000);
    const recorded: unknown[] = [];
    const d: SyncDeps = {
      now: () => NOW,
      existingIds: async () => new Set(),
      priceAt: async (s, at) => {
        const rows = rowsAt(1234);
        rows.products[0]!.taxCategory = at < change ? "SECOND_REDUCED" : "STANDARD";
        const cart = buildServerCart(s, rows);
        return {
          cart,
          priced: priceCart(cart, { country: "IE", date: "2026-10-06", rates: IRISH_RATES }),
        };
      },
      recordSale: async (p) => {
        recorded.push(p);
        return "created";
      },
      recordRejection: async () => {},
    };
    // €12.34 at 9%: VAT 102c (at 23% it would be 231c).
    await processBatch(
      [sale({ catalogAsOf: pulled.toISOString(), expectedVatCents: 102 })],
      ctx,
      d,
    );
    const rec = recordOf(recorded);
    expect(rec.vat).toBe(102);
    expect(rec.priced_as_of).toBe(pulled.toISOString());
    // Same price at both moments, so this is not "old prices" either.
    expect(rec.review_flags).toEqual([]);
  });

  it("VAT must match exactly: 1c off is flagged", async () => {
    const { d, recorded } = deps(() => 1234);
    await processBatch([sale({ expectedVatCents: 230 })], ctx, d);
    expect(recordOf(recorded).review_flags).toEqual(["vat_differs"]);
  });
});
