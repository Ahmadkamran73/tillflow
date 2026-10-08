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
const CASH_TYPE = "00000000-0000-4000-8000-0000000000c1";
const CARD_TYPE = "00000000-0000-4000-8000-0000000000c2";
const VOUCHER_TYPE = "00000000-0000-4000-8000-0000000000c3";
const TYPE = { cash: CASH_TYPE, card: CARD_TYPE, voucher: VOUCHER_TYPE };
let tn = 0;
const tender = (method: "cash" | "card" | "voucher", amountCents: number, extra = {}) => ({
  id: `00000000-0000-7000-9000-${String(++tn).padStart(12, "0")}`,
  typeId: TYPE[method],
  method,
  amountCents,
  tipCents: 0,
  ...extra,
});
const ctx = {
  orgId: "00000000-0000-4000-8000-0000000000f1",
  registerId: "00000000-0000-4000-8000-0000000000e1",
  discountOverrideBp: 1000,
  tenderTypes: [
    { id: CASH_TYPE, method: "cash" },
    { id: CARD_TYPE, method: "card" },
    { id: VOUCHER_TYPE, method: "voucher" },
  ],
  tipsAllowed: false,
  shopRoundCash: true,
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
  tenders: [tender("cash", 2000)],
  roundCash: true,
  expectedDueCents: 1235, // €12.34 rounds to €12.35 for cash
  ...over,
});

/** A server whose catalogue price depends on the moment asked about. */
function deps(priceAt: (at: Date) => number | "unknown", over: Partial<SyncDeps> = {}) {
  const recorded: unknown[] = [];
  const rejections: Record<string, unknown>[] = [];
  const notes: Record<string, unknown>[] = [];
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
    recordNote: async (p) => {
      notes.push(p as Record<string, unknown>);
    },
    ...over,
  };
  return { d, recorded, rejections, notes };
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
    const [r] = await processBatch([sale({ tenders: [tender("cash", 1000)] })], ctx, d);
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
    // Cash-only: the rounding is on the whole total.
    const due = priceCart(cart, { country: "IE", date: "2026-10-06", rates: IRISH_RATES }, "cash")
      .basket.amountDue;
    return { ...base, expectedDueCents: due, tenders: [tender("cash", 5000)] };
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

describe("tenders (step 2.1)", () => {
  // The item is 12.34. Card and voucher are exact; the 5c rounding is on the cash share only.
  const split = (tenders: ReturnType<typeof tender>[], due: number) =>
    sale({ tenders, expectedDueCents: due });

  it("accepts card only, exact, with no rounding and a recorded reference", async () => {
    const { d, recorded } = deps(() => 1234);
    const s = split([tender("card", 1234, { reference: "AUTH 123456" })], 1234);
    expect((await processBatch([s], ctx, d))[0]!.status).toBe("created");
    const rec = recorded[0] as {
      sale: Record<string, number>;
      payments: Record<string, unknown>[];
    };
    expect(rec.sale).toMatchObject({ amount_due: 1234, cash_rounding: 0 });
    expect(rec.payments).toEqual([
      {
        type_id: CARD_TYPE,
        method: "card",
        amount: 1234,
        tendered: 1234,
        change: 0,
        tip: 0,
        reference: "AUTH 123456",
      },
    ]);
  });

  it("a shop that does not round cash: exact cash, no rounding line, a rounded till total is refused", async () => {
    const exact = ctx;
    const { d, recorded } = deps(() => 1234);
    const ok = await processBatch(
      [{ ...split([tender("cash", 2000)], 1234), roundCash: false }],
      exact,
      d,
    );
    expect(ok[0]!.status).toBe("created");
    const rec = recorded[0] as { sale: Record<string, number>; payments: Record<string, number>[] };
    expect(rec.sale).toMatchObject({ amount_due: 1234, cash_rounding: 0 });
    expect(rec.payments[0]).toMatchObject({ amount: 1234, tendered: 2000, change: 766 });
    // The sale's own mode decides, not the shop's setting at sync time: a till that did not round
    // but claims a rounded total is refused, and one that rounded is accepted.
    const off = await processBatch(
      [{ ...split([tender("cash", 2000)], 1237), roundCash: false }],
      exact,
      d,
    );
    expect(off[0]).toMatchObject({ status: "rejected", reason: "price_mismatch" });
    const rounded = await processBatch([split([tender("cash", 2000)], 1235)], exact, d);
    expect(rounded[0]!.status).toBe("created"); // no flag = rounded, as before
  });

  it("accepts card + cash: rounding only on the cash share, change only from cash", async () => {
    const { d, recorded } = deps(() => 1234);
    // card 5.00 -> cash share 7.34 rounds to 7.35; 10.00 handed over -> change 2.65
    const s = split([tender("card", 500), tender("cash", 1000)], 1235);
    expect((await processBatch([s], ctx, d))[0]!.status).toBe("created");
    const rec = recorded[0] as { sale: Record<string, number>; payments: Record<string, number>[] };
    expect(rec.sale).toMatchObject({ amount_due: 1235, cash_rounding: 1 });
    expect(rec.payments[1]).toMatchObject({
      method: "cash",
      amount: 735,
      tendered: 1000,
      change: 265,
    });
  });

  it("accepts voucher + card + cash in any order", async () => {
    const { d } = deps(() => 1234);
    const s = split([tender("cash", 600), tender("voucher", 300), tender("card", 400)], 1235);
    expect((await processBatch([s], ctx, d))[0]!.status).toBe("created");
  });

  it("rejects card or voucher above the total", async () => {
    const { d, recorded } = deps(() => 1234);
    const r = await processBatch([split([tender("card", 1300)], 1234)], ctx, d);
    expect(r[0]).toMatchObject({ status: "rejected", reason: "tender_mismatch" });
    expect(recorded).toHaveLength(0);
  });

  it("rejects payments that do not cover the amount due", async () => {
    const { d } = deps(() => 1234);
    const r = await processBatch([split([tender("card", 1000)], 1234)], ctx, d);
    expect(r[0]).toMatchObject({ status: "rejected", reason: "short_tender" });
  });

  it("rejects a till total that differs from the server's split total", async () => {
    const { d } = deps(() => 1234);
    // card only: the server's due is 1234, not the cash-rounded 1235
    const r = await processBatch([split([tender("card", 1234)], 1240)], ctx, d);
    expect(r[0]).toMatchObject({ status: "rejected", reason: "price_mismatch" });
  });

  it("rejects a payment type that is not this shop's, or has the wrong method", async () => {
    const { d, rejections } = deps(() => 1234);
    const other = tender("card", 1234, { typeId: "00000000-0000-4000-8000-0000000000ff" });
    const wrong = tender("card", 1234, { typeId: CASH_TYPE });
    for (const t of [other, wrong]) {
      const [r] = await processBatch([split([t], 1234)], ctx, d);
      expect(r).toMatchObject({ status: "rejected", reason: "unknown_tender" });
    }
    expect(rejections).toHaveLength(2);
  });

  it("tips: stored on the card, outside the total, only where the shop takes tips", async () => {
    const { d, recorded } = deps(() => 1234);
    const tipped = split([tender("card", 1234, { tipCents: 150 })], 1234);
    const no = await processBatch([tipped], ctx, d);
    expect(no[0]).toMatchObject({ status: "rejected", reason: "tender_mismatch" });
    const yes = await processBatch(
      [{ ...tipped, id: sale().id }],
      { ...ctx, tipsAllowed: true },
      d,
    );
    expect(yes[0]!.status).toBe("created");
    const rec = recorded[0] as { sale: Record<string, number>; payments: Record<string, number>[] };
    expect(rec.sale.amount_due).toBe(1234);
    expect(rec.payments[0]).toMatchObject({ amount: 1234, tip: 150 });
  });

  it("refuses a tip on cash or above the card amount at the door (invalid)", async () => {
    const { d } = deps(() => 1234);
    const cashTip = split([tender("cash", 2000, { tipCents: 5 })], 1235);
    const big = split([tender("card", 1234, { tipCents: 1235 })], 1234);
    const results = await processBatch([cashTip, big], { ...ctx, tipsAllowed: true }, d);
    expect(results[0]).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(results[1]).toMatchObject({ status: "rejected", reason: "tender_mismatch" });
  });

  it("still accepts a sale queued with the old single tenderedCents", async () => {
    const { d, recorded } = deps(() => 1234);
    const { tenders: _t, ...rest } = sale();
    void _t;
    const legacy = { ...rest, tenderedCents: 2000 };
    expect((await processBatch([legacy], ctx, d))[0]!.status).toBe("created");
    const rec = recorded[0] as { payments: Record<string, unknown>[] };
    expect(rec.payments).toEqual([
      { type_id: null, method: "cash", amount: 1235, tendered: 2000, change: 765 },
    ]);
  });

  it("never keeps a card-number-like reference in a stored rejection", async () => {
    const { d, rejections } = deps(() => 1234);
    const bad = sale({ tenders: [tender("card", 1234, { reference: "4111111111111111" })] });
    const [r] = await processBatch([bad], ctx, d);
    expect(r).toMatchObject({ status: "rejected", reason: "invalid" });
    expect(JSON.stringify(rejections[0])).not.toContain("4111111111111111");
  });
});

describe("rounding mode of the sale vs the shop's current setting", () => {
  const cashSale = (roundCash: boolean | unknown, due: number) =>
    ({ ...sale({ expectedDueCents: due }), roundCash }) as SyncSale;

  it("matching: syncs and leaves no note", async () => {
    const { d, recorded, notes } = deps(() => 1234);
    const [r] = await processBatch([cashSale(true, 1235)], ctx, d);
    expect(r!.status).toBe("created");
    expect(recorded).toHaveLength(1);
    expect(notes).toHaveLength(0);
    const exact = deps(() => 1234);
    const [e] = await processBatch(
      [cashSale(false, 1234)],
      { ...ctx, shopRoundCash: false },
      exact.d,
    );
    expect(e!.status).toBe("created");
    expect(exact.notes).toHaveLength(0);
  });

  it("mismatch: still syncs, the sale keeps its own mode, and an audit note is written", async () => {
    // Rung up exact (shop did not round then); the shop's setting is now "round".
    const a = deps(() => 1234);
    const s1 = cashSale(false, 1234);
    const [r1] = await processBatch([s1], { ...ctx, shopRoundCash: true }, a.d);
    expect(r1!.status).toBe("created");
    const rec1 = a.recorded[0] as { sale: Record<string, number> };
    expect(rec1.sale).toMatchObject({ amount_due: 1234, cash_rounding: 0 });
    expect(a.notes).toEqual([
      {
        kind: "rounding_mode_differs",
        org_id: ctx.orgId,
        sale_id: s1.id,
        user_id: CASHIER,
        sale_round_cash: false,
        shop_round_cash: true,
      },
    ]);

    // Rung up rounded; the shop's setting is now "exact".
    const b = deps(() => 1234);
    const [r2] = await processBatch([cashSale(true, 1235)], { ...ctx, shopRoundCash: false }, b.d);
    expect(r2!.status).toBe("created");
    expect((b.recorded[0] as { sale: Record<string, number> }).sale).toMatchObject({
      amount_due: 1235,
      cash_rounding: 1,
    });
    expect(b.notes[0]).toMatchObject({ sale_round_cash: true, shop_round_cash: false });
  });

  it("the server still does the rounding: a till's own total or flag cannot move the amount", async () => {
    // The sale says "round" but claims the unrounded total: the server computes 1235, 1c off is
    // tolerated, the stored amount is the server's.
    const { d, recorded } = deps(() => 1234);
    const [r] = await processBatch([cashSale(true, 1234)], ctx, d);
    expect(r!.status).toBe("created");
    expect((recorded[0] as { sale: Record<string, number> }).sale.amount_due).toBe(1235);
    // 2c away from what its own mode gives is refused.
    const bad = deps(() => 1234);
    const [x] = await processBatch([cashSale(true, 1237)], ctx, bad.d);
    expect(x).toMatchObject({ status: "rejected", reason: "price_mismatch" });
    expect(bad.notes).toHaveLength(0); // a refused sale gets no note
  });

  it("a note that cannot be written never fails the sale; a replay writes none", async () => {
    const failing = deps(() => 1234, {
      recordNote: async () => {
        throw new Error("audit down");
      },
    });
    const [r] = await processBatch([cashSale(false, 1234)], ctx, failing.d);
    expect(r!.status).toBe("created");

    const dup = deps(() => 1234, { recordSale: async () => "duplicate" });
    await processBatch([cashSale(false, 1234)], ctx, dup.d);
    expect(dup.notes).toHaveLength(0);
  });

  it("roundCash must be a real boolean: anything else is an invalid sale", async () => {
    const { d, recorded, notes } = deps(() => 1234);
    const results = await processBatch(
      [cashSale("false", 1234), cashSale(0, 1234), cashSale(null, 1234)],
      ctx,
      d,
    );
    expect(results.map((r) => [r.status, r.reason])).toEqual([
      ["rejected", "invalid"],
      ["rejected", "invalid"],
      ["rejected", "invalid"],
    ]);
    expect(recorded).toHaveLength(0);
    expect(notes).toHaveLength(0);
    // Missing = a sale queued before the flag existed = rounded.
    const { roundCash: _r, ...legacy } = cashSale(true, 1235);
    void _r;
    expect((await processBatch([legacy], ctx, d))[0]!.status).toBe("created");
  });
});
