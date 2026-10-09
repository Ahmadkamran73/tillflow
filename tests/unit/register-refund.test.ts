import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import { priceCart, type Cart } from "@/lib/register/cart";
import {
  RegisterDb,
  type LocalRefund,
  type LocalSale,
  type LocalTender,
} from "@/lib/register/db";
import {
  applyLocalRefunds,
  completeExchange,
  completeRefund,
  detailOfLocalSale,
  findLocalSale,
  lookupOnServer,
  recentLocalSales,
  refundReceiptNo,
  refundable,
  refundsOfSale,
  saleCode,
  saleIdOfCode,
} from "@/lib/register/refund";
import { buildRefundReceipt, refundReceiptText } from "@/lib/register/refund-receipt";
import { buildReceipt, receiptLabels, receiptText } from "@/lib/register/receipt";
import { BARCODE_MARK, encodeEscpos } from "@/lib/register/print/escpos";
import { completeSale } from "@/lib/register/sale";
import { drainOutbox, pendingSales, sendableRefunds, sendableSales } from "@/lib/sync/outbox";
import { buildSaleRecord } from "@/lib/sync/sale-record";
import { settleTenders } from "@/lib/money";
import { priceRefundLines } from "@/lib/sync/refund-price";
import { IRISH_RATES } from "./money/irish-rates";

const ORG = "00000000-0000-4000-8000-0000000000f1";
const REG = "00000000-0000-4000-8000-0000000000e1";
const CASHIER = "00000000-0000-4000-8000-0000000000d1";
const V1 = "00000000-0000-4000-8000-000000000001";
const V2 = "00000000-0000-4000-8000-000000000002";
const CARD = "00000000-0000-4000-8000-0000000000c2";

const ctx = { country: "IE", date: "2026-10-06", rates: IRISH_RATES };

// 3 x water at 2.50 with a 15c deposit each (23%?), and a coffee at 3.20 (REDUCED? use STANDARD/SECOND)
const cart: Cart = {
  ageChecked: true,
  lines: [
    {
      id: "l1",
      variantId: V1,
      productId: "p1",
      name: "Water",
      unitPriceCents: 250,
      modifiers: [],
      qty: 3,
      taxCategory: "STANDARD",
      takeawayTaxCategory: null,
      depositCents: 15,
    },
    {
      id: "l2",
      variantId: V2,
      productId: "p2",
      name: "Phone case",
      unitPriceCents: 1999,
      modifiers: [],
      qty: 1,
      taxCategory: "STANDARD",
      takeawayTaxCategory: null,
      depositCents: 0,
      serial: "IMEI-4242",
    },
  ],
};

const cash = (amountCents: number) => ({
  id: "00000000-0000-7000-9000-000000000001",
  typeId: null,
  method: "cash" as const,
  amountCents,
  tipCents: 0,
  label: "Cash",
});
const card = (amountCents: number) => ({
  id: "00000000-0000-7000-9000-000000000002",
  typeId: CARD,
  method: "card" as const,
  amountCents,
  tipCents: 0,
  label: "Card",
});

let db: RegisterDb;
beforeEach(async () => {
  await Dexie.delete(`tillflow-${ORG}`);
  db = new RegisterDb(ORG);
});

const priced = priceCart(cart, ctx);
const total = priced.basket.total;

async function sell(tenders: LocalTender[] = [card(total)]) {
  return completeSale(db, {
    registerId: REG,
    cashierUserId: CASHIER,
    cart,
    tenders,
    roundCash: true,
    expectedDueCents: settleTenders(
      total,
      tenders.map((t) => ({ method: t.method, amount: t.amountCents })),
    ).amountDue,
  });
}

describe("sale codes", () => {
  it("round-trip a sale id through the receipt barcode text", () => {
    const id = "01927a3c-5b2e-7c11-8f00-a1b2c3d4e5f6";
    const code = saleCode(id);
    expect(code).toBe("TF01927a3c5b2e7c118f00a1b2c3d4e5f6");
    expect(saleIdOfCode(code)).toBe(id);
    expect(saleIdOfCode(code.toUpperCase().replace("TF", "TF"))).toBe(id);
    expect(saleIdOfCode("5391234567890")).toBeNull();
    expect(saleIdOfCode("TF123")).toBeNull();
    expect(refundReceiptNo("Till 1", 3)).toBe("Till 1 · R000003");
  });
});

describe("detailOfLocalSale", () => {
  it("describes a sale the way the server stores it: same line numbers, snapshot rate and amounts", async () => {
    const sale = await sell();
    const detail = detailOfLocalSale(sale, priced, "Till 1");
    // what the server would store for the same sale
    const record = buildSaleRecord({
      orgId: ORG,
      registerId: REG,
      userId: CASHIER,
      sale: {
        id: sale.id,
        cashierUserId: CASHIER,
        receiptSeq: 1,
        completedAt: sale.completedAt,
        mode: "eat_in",
        lines: [],
        tenders: sale.tenders,
        roundCash: true,
        expectedDueCents: total,
      },
      cart,
      priced,
      settlement: settleTenders(total, [{ method: "card", amount: total }]),
      pricedAsOf: new Date(),
    });
    const stored = record.lines as Record<string, unknown>[];
    expect(detail.lines).toHaveLength(stored.length);
    detail.lines.forEach((l, i) => {
      expect(l.line_no).toBe(i + 1);
      expect(l.kind).toBe(stored[i]!.kind);
      expect(l.gross).toBe(stored[i]!.gross_cents);
      expect(l.vat).toBe(stored[i]!.vat_cents ?? null);
      expect(l.tax_rate_bp).toBe(stored[i]!.tax_rate_bp ?? null);
      expect(l.qty).toBe(stored[i]!.qty);
    });
    // water (item), water deposit, phone case
    expect(detail.lines.map((l) => [l.name, l.kind])).toEqual([
      ["Water", "item"],
      ["Water", "deposit"],
      ["Phone case", "item"],
    ]);
    expect(detail.lines[2]!.serial).toBe("IMEI-4242");
    expect(detail.payments).toEqual([
      { method: "card", type_id: CARD, label: "Card", amount: total, tip: 0 },
    ]);
  });

  it("cash is the share plus rounding (what was handed over less the change)", async () => {
    const sale = await sell([cash(5000)]);
    const detail = detailOfLocalSale(sale, priced, "Till 1");
    const s = settleTenders(total, [{ method: "cash", amount: 5000 }]);
    expect(detail.payments[0]!.amount).toBe(s.cashShare + s.rounding);
    expect(detail.sale.amount_due).toBe(s.amountDue);
  });

  it("splits partial refunds of it exactly, at the sale's own rate", async () => {
    const sale = await sell();
    const detail = detailOfLocalSale(sale, priced, "Till 1");
    const first = priceRefundLines(detail, [{ lineNo: 1, qty: 1, restock: true }]);
    expect(first.ok).toBe(true);
    const after = applyLocalRefunds(detail, [
      fakeRefund(sale.id, [{ lineNo: 1, qty: 1 }], [{ method: "card", amountCents: 100 }]),
    ]);
    expect(after.lines[0]!.refunded_qty).toBe(1);
    expect(after.refunded).toEqual({ cash: 0, card: 100, value: 0, cash_refunds: 0 });
    const rest = priceRefundLines(after, [{ lineNo: 1, qty: 2, restock: true }]);
    if (!first.ok || !rest.ok) throw new Error("pricing failed");
    expect(first.lines[0]!.gross + rest.lines[0]!.gross).toBe(detail.lines[0]!.gross);
    expect(first.lines[0]!.vat + rest.lines[0]!.vat).toBe(detail.lines[0]!.vat);
    // a fourth unit does not exist
    expect(priceRefundLines(after, [{ lineNo: 1, qty: 3, restock: true }])).toMatchObject({
      ok: false,
      error: "too_many",
      left: 2,
    });
  });
});

function fakeRefund(
  saleId: string,
  lines: { lineNo: number; qty: number }[],
  legs: { method: "cash" | "card"; amountCents: number }[],
): LocalRefund {
  return {
    id: crypto.randomUUID(),
    registerId: REG,
    cashierUserId: CASHIER,
    originalSaleId: saleId,
    originalReceiptNo: "Till 1 · 000001",
    kind: "refund",
    reasonCode: "changed_mind",
    receiptSeq: 1,
    completedAt: new Date().toISOString(),
    lines: lines.map((l) => ({
      ...l,
      restock: true,
      kind: "item",
      name: "Water",
      serial: null,
      rateBp: 2300,
      grossCents: 0,
      vatCents: 0,
      netCents: 0,
    })),
    legs: legs.map((l) => ({
      id: crypto.randomUUID(),
      typeId: null,
      tipCents: 0,
      label: l.method,
      ...l,
    })),
    creditCents: 0,
    roundCash: true,
    roundingCents: 0,
    expectedAmountCents: 0,
    syncState: "pending",
    attempts: 0,
  };
}

describe("finding sales on the device", () => {
  it("finds by receipt number, id and serial; skips rejected sales; lists the newest first", async () => {
    const a = await sell();
    const b = await sell();
    await db.sales.update(b.id, { syncState: "rejected" });
    const c = await sell();
    expect(
      (await findLocalSale(db, { by: "receipt", registerId: REG, seq: a.receiptSeq })).map(
        (s) => s.id,
      ),
    ).toEqual([a.id]);
    expect(await findLocalSale(db, { by: "receipt", registerId: REG, seq: b.receiptSeq })).toEqual(
      [],
    );
    expect((await findLocalSale(db, { by: "id", id: c.id })).map((s) => s.id)).toEqual([c.id]);
    expect(
      (await findLocalSale(db, { by: "serial", serial: "imei-4242" })).map((s) => s.id).sort(),
    ).toEqual([a.id, c.id].sort());
    expect(await findLocalSale(db, { by: "serial", serial: "nothing" })).toEqual([]);
    const recent = await recentLocalSales(db, 10);
    expect(recent.map((s) => s.id)).toEqual([c.id, a.id]);
  });

  it("reports how much of a sale can still be given back", async () => {
    const sale = await sell();
    const detail = detailOfLocalSale(sale, priced, "Till 1");
    const r = refundable(detail);
    expect(r.unitsLeft).toBe(4);
    expect(r.available).toEqual({ cash: 0, card: total });
  });
});

describe("completeRefund", () => {
  const base = (saleId: string) => ({
    registerId: REG,
    cashierUserId: CASHIER,
    originalSaleId: saleId,
    originalReceiptNo: "Till 1 · 000001",
    kind: "refund" as const,
    reasonCode: "faulty" as const,
    lines: [],
    legs: [],
    roundCash: true,
    roundingCents: 0,
    expectedAmountCents: 0,
  });

  it("numbers refunds in their own gap-free series and leaves the sale alone", async () => {
    const sale = await sell();
    const before = JSON.stringify(await db.sales.get(sale.id));
    const one = await completeRefund(db, base(sale.id));
    const two = await completeRefund(db, base(sale.id));
    expect([one.receiptSeq, two.receiptSeq]).toEqual([1, 2]);
    expect(one).toMatchObject({ syncState: "pending", attempts: 0, creditCents: 0 });
    expect(JSON.stringify(await db.sales.get(sale.id))).toBe(before);
    expect((await refundsOfSale(db, sale.id)).map((r) => r.receiptSeq).sort()).toEqual([1, 2]);
  });

  it("carries on after the highest number the server holds for this till", async () => {
    await db.meta.put({
      key: "registers",
      value: [{ id: REG, name: "Till 1", lastSeq: 9, lastRefundSeq: 41 }],
    });
    const sale = await sell();
    expect((await completeRefund(db, base(sale.id))).receiptSeq).toBe(42);
  });

  it("keeps an approval proof, or only the manager the till names when offline", async () => {
    const sale = await sell();
    const online = await completeRefund(db, {
      ...base(sale.id),
      approvalId: "a1",
      claimedApprover: "m1",
    });
    expect(online).toMatchObject({ approvalId: "a1", claimedApprover: undefined });
    const offline = await completeRefund(db, { ...base(sale.id), claimedApprover: "m1" });
    expect(offline).toMatchObject({ approvalId: undefined, claimedApprover: "m1" });
  });
});

describe("completeExchange", () => {
  const input = (saleId: string, over = {}) => ({
    id: "00000000-0000-7000-8000-00000000e001",
    completedAt: new Date().toISOString(),
    registerId: REG,
    cashierUserId: CASHIER,
    originalSaleId: saleId,
    originalReceiptNo: "Till 1 · 000001",
    kind: "exchange" as const,
    reasonCode: "wrong_item" as const,
    lines: [],
    legs: [],
    creditCents: 100,
    exchangeSaleId: "00000000-0000-7000-8000-00000000e002",
    roundCash: true,
    roundingCents: 0,
    expectedAmountCents: 0,
    ...over,
  });
  const saleArgs = (over = {}) => ({
    id: "00000000-0000-7000-8000-00000000e002",
    exchangeRefundId: "00000000-0000-7000-8000-00000000e001",
    registerId: REG,
    cashierUserId: CASHIER,
    cart,
    tenders: [card(total)],
    roundCash: true,
    expectedDueCents: total,
    ...over,
  });

  it("saves the refund and the sale that spends its credit together, and clears the draft", async () => {
    const original = await sell();
    await db.meta.put({ key: "exchangeDraft", value: { refundId: "x" } });
    const { refund, sale } = await completeExchange(db, {
      refund: input(original.id),
      sale: saleArgs(),
    });
    expect(refund).toMatchObject({ id: "00000000-0000-7000-8000-00000000e001", kind: "exchange" });
    expect(sale).toMatchObject({
      id: "00000000-0000-7000-8000-00000000e002",
      exchangeRefundId: refund.id,
    });
    expect(await db.refunds.count()).toBe(1);
    expect(await db.sales.count()).toBe(2);
    expect(await db.meta.get("exchangeDraft")).toBeUndefined();
  });

  it("is all or nothing: if the sale cannot be saved, no refund is left behind", async () => {
    const original = await sell();
    // the exchange sale's id is already taken, so saving the sale fails
    await expect(
      completeExchange(db, {
        refund: input(original.id),
        sale: saleArgs({ id: original.id }),
      }),
    ).rejects.toBeTruthy();
    expect(await db.refunds.count()).toBe(0);
    expect(await db.sales.count()).toBe(1);
    expect(await db.meta.get(`refundSeq:${REG}`)).toBeUndefined();
  });
});

describe("lookupOnServer", () => {
  const answer = (status: number, body?: unknown) =>
    (async () => Response.json(body ?? {}, { status })) as unknown as typeof fetch;

  it("asks for the sale and parses what comes back, and never throws", async () => {
    const sale = await sell();
    const detail = detailOfLocalSale(sale, priced, "Till 1");
    // the server describes lines with real row ids
    detail.lines = detail.lines.map((l) => ({ ...l, id: crypto.randomUUID() }));
    const ok = await lookupOnServer(ORG, { by: "id", id: sale.id }, CASHIER, answer(200, { sales: [detail] }),
    );
    expect(ok).toMatchObject({ status: "ok" });
    expect(
      (await lookupOnServer(ORG, { by: "id", id: sale.id }, CASHIER, answer(200, { sales: [{ nope: 1 }] })))
        .status,
    ).toBe("failed");
    expect((await lookupOnServer(ORG, { by: "id", id: sale.id }, CASHIER, answer(401))).status).toBe(
      "unpaired",
    );
    expect((await lookupOnServer(ORG, { by: "id", id: sale.id }, CASHIER, answer(503))).status).toBe(
      "failed",
    );
    const offline = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect((await lookupOnServer(ORG, { by: "serial", serial: "x" }, CASHIER, offline)).status).toBe(
      "offline",
    );
    let url = "";
    const spy = (async (u: string) => {
      url = u;
      return Response.json({ sales: [] });
    }) as unknown as typeof fetch;
    await lookupOnServer(ORG, { by: "receipt", registerId: REG, seq: 7 }, CASHIER, spy);
    // who is serving travels as the server-signed token in a header, never as a name in the URL
    const seen: { url: string; headers: unknown }[] = [];
    const header = (async (u: string, init: RequestInit) => {
      seen.push({ url: u, headers: init.headers });
      return Response.json({ sales: [] });
    }) as unknown as typeof fetch;
    await lookupOnServer(ORG, { by: "serial", serial: "abc" }, "payload.sig", header);
    await lookupOnServer(ORG, { by: "serial", serial: "abc" }, undefined, header);
    expect(seen[0]!.headers).toEqual({ "x-serving-token": "payload.sig" });
    expect(seen[0]!.url).not.toContain("payload.sig");
    expect(seen[0]!.url).not.toContain("as=");
    expect(seen[1]!.headers).toBeUndefined();
    expect(url).toContain("by=receipt");
    expect(url).toContain(`register_id=${REG}`);
    expect(url).toContain("seq=7");
  });
});

describe("the outbox with refunds", () => {
  type Sent = { url: string; ids: string[] };
  function server(answer: (id: string, url: string) => string = () => "created") {
    const sent: Sent[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as {
        sales?: { id: string }[];
        refunds?: { id: string }[];
      };
      const items = body.sales ?? body.refunds ?? [];
      sent.push({ url, ids: items.map((i) => i.id) });
      return Response.json({
        results: items.map((i) => ({ id: i.id, status: answer(i.id, url) })),
      });
    }) as unknown as typeof fetch;
    return { sent, fetchFn };
  }

  const refundOf = (saleId: string, extra: Partial<Parameters<typeof completeRefund>[1]> = {}) =>
    completeRefund(db, {
      registerId: REG,
      cashierUserId: CASHIER,
      originalSaleId: saleId,
      originalReceiptNo: "Till 1 · 000001",
      kind: "refund",
      reasonCode: "faulty",
      lines: [
        {
          lineNo: 1,
          saleLineId: "x",
          qty: 1,
          restock: true,
          kind: "item",
          name: "Water",
          serial: null,
          rateBp: 2300,
          gross: 250,
          vat: 47,
          net: 203,
        },
      ],
      legs: [
        {
          id: "00000000-0000-7000-a000-000000000001",
          typeId: CARD,
          method: "card",
          amountCents: 250,
          tipCents: 0,
          label: "Card",
        },
      ],
      roundCash: true,
      roundingCents: 0,
      expectedAmountCents: 250,
      ...extra,
    });

  it("sends sales first, then the refunds of them, and marks refunds synced", async () => {
    const sale = await sell();
    const refund = await refundOf(sale.id);
    const s = server();
    const res = await drainOutbox(db, ORG, { fetchFn: s.fetchFn, force: true });
    expect(res.state).toBe("idle");
    expect(s.sent.map((x) => x.url.split("?")[0])).toEqual([
      "/api/v1/sync/sales",
      "/api/v1/sync/refunds",
    ]);
    expect(s.sent[1]!.ids).toEqual([refund.id]);
    expect((await db.refunds.get(refund.id))!.syncState).toBe("synced");
    expect((await db.sales.get(sale.id))!.syncState).toBe("synced");
  });

  it("sends the signed serving token with the refund, and no other proof of who is serving", async () => {
    const sale = await sell();
    await refundOf(sale.id, { servingToken: "payload.sig" });
    let body = "";
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.includes("refunds")) body = init.body as string;
      const parsed = JSON.parse(init.body as string) as { sales?: { id: string }[]; refunds?: { id: string }[] };
      return Response.json({ results: (parsed.sales ?? parsed.refunds ?? []).map((i) => ({ id: i.id, status: "created" })) });
    }) as unknown as typeof fetch;
    await drainOutbox(db, ORG, { fetchFn, force: true });
    expect(JSON.parse(body).refunds[0].servingToken).toBe("payload.sig");
  });

  it("drops the signed token from the device once the server has judged the refund", async () => {
    const sale = await sell();
    await db.sales.update(sale.id, { syncState: "synced" });
    const ok = await refundOf(sale.id, { servingToken: "payload.sig" });
    const bad = await refundOf(sale.id, { servingToken: "payload.sig2" });
    expect((await db.refunds.get(ok.id))!.servingToken).toBe("payload.sig");
    await drainOutbox(db, ORG, {
      fetchFn: server((id) => (id === bad.id ? "rejected" : "created")).fetchFn,
      force: true,
    });
    const synced = await db.refunds.get(ok.id);
    const rejected = await db.refunds.get(bad.id);
    expect(synced!.syncState).toBe("synced");
    expect(rejected!.syncState).toBe("rejected");
    expect(synced!.servingToken).toBeUndefined();
    expect(rejected!.servingToken).toBeUndefined();
  });

  it("never sends the till's label or an unknown field in a refund", async () => {
    const sale = await sell();
    await refundOf(sale.id);
    let body = "";
    const fetchFn = (async (url: string, init: RequestInit) => {
      if (url.includes("refunds")) body = init.body as string;
      const parsed = JSON.parse(init.body as string) as {
        sales?: { id: string }[];
        refunds?: { id: string }[];
      };
      return Response.json({
        results: (parsed.sales ?? parsed.refunds ?? []).map((i) => ({
          id: i.id,
          status: "created",
        })),
      });
    }) as unknown as typeof fetch;
    await drainOutbox(db, ORG, { fetchFn, force: true });
    const wire = JSON.parse(body).refunds[0];
    expect(wire.legs[0]).toEqual({
      id: expect.any(String),
      typeId: CARD,
      method: "card",
      amountCents: 250,
      tipCents: 0,
    });
    expect(wire.lines).toEqual([{ lineNo: 1, qty: 1, restock: true }]);
    expect(wire).not.toHaveProperty("originalReceiptNo");
    expect(wire).not.toHaveProperty("syncState");
  });

  it("holds a refund while its sale is still queued, and an exchange sale while its refund is", async () => {
    const sale = await sell();
    const refund = await refundOf(sale.id);
    expect((await sendableRefunds(db)).map((r) => r.id)).toEqual([]); // the sale is still pending
    expect((await sendableSales(db)).map((x) => x.id)).toEqual([sale.id]);
    await db.sales.update(sale.id, { syncState: "synced" });
    expect((await sendableRefunds(db)).map((r) => r.id)).toEqual([refund.id]);

    const exchangeSale = await sell();
    await db.sales.update(exchangeSale.id, { exchangeRefundId: refund.id });
    expect((await sendableSales(db)).map((x) => x.id)).not.toContain(exchangeSale.id);
    await db.refunds.update(refund.id, { syncState: "synced" });
    expect((await sendableSales(db)).map((x) => x.id)).toContain(exchangeSale.id);
  });

  it("sends the refund of an exchange before the sale that spends its credit", async () => {
    const original = await sell();
    await db.sales.update(original.id, { syncState: "synced" });
    const refund = await refundOf(original.id, {
      kind: "exchange",
      creditCents: 250,
      exchangeSaleId: "00000000-0000-7000-8000-00000000abcd",
      legs: [],
      expectedAmountCents: 0,
    });
    const exSale = await sell();
    await db.sales.update(exSale.id, { exchangeRefundId: refund.id });
    const s = server();
    await drainOutbox(db, ORG, { fetchFn: s.fetchFn, force: true });
    expect(s.sent.map((x) => x.url.split("?")[0])).toEqual([
      "/api/v1/sync/refunds",
      "/api/v1/sync/sales",
    ]);
    expect(await pendingSales(db)).toHaveLength(0);
  });

  it("an exchange sale whose refund the server refused is marked rejected, not left blocking the queue", async () => {
    const original = await sell();
    await db.sales.update(original.id, { syncState: "synced" });
    const refund = await refundOf(original.id, {
      kind: "exchange",
      creditCents: 250,
      exchangeSaleId: "00000000-0000-7000-8000-00000000abcd",
      legs: [],
      expectedAmountCents: 0,
    });
    const exSale = await sell();
    await db.sales.update(exSale.id, { exchangeRefundId: refund.id });
    // the server refuses the refund
    await drainOutbox(db, ORG, { fetchFn: server(() => "rejected").fetchFn, force: true });
    expect((await db.refunds.get(refund.id))!.syncState).toBe("rejected");
    // the next drain does not try to send the sale (the server would wait for the refund forever)
    const s = server();
    await drainOutbox(db, ORG, { fetchFn: s.fetchFn, force: true });
    expect(s.sent.flatMap((x) => x.ids)).not.toContain(exSale.id);
    expect(await db.sales.get(exSale.id)).toMatchObject({
      syncState: "rejected",
      rejectReason: "exchange_refund_rejected",
    });
  });

  it("keeps a refund queued on `retry`, flags a rejected one, and never drops either", async () => {
    const sale = await sell();
    await db.sales.update(sale.id, { syncState: "synced" });
    const waiting = await refundOf(sale.id);
    const res = await drainOutbox(db, ORG, { fetchFn: server(() => "retry").fetchFn, force: true });
    expect(res.state).toBe("backoff");
    expect(await db.refunds.get(waiting.id)).toMatchObject({ syncState: "pending", attempts: 1 });

    const bad = await drainOutbox(db, ORG, {
      fetchFn: server(() => "rejected").fetchFn,
      force: true,
    });
    expect(bad.state).toBe("idle");
    expect(await db.refunds.get(waiting.id)).toMatchObject({ syncState: "rejected" });
  });

  it("backs off when the server cannot be reached and goes `signed-out` on 401", async () => {
    const sale = await sell();
    await db.sales.update(sale.id, { syncState: "synced" });
    const r = await refundOf(sale.id);
    const down = (async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    expect((await drainOutbox(db, ORG, { fetchFn: down, force: true })).state).toBe("backoff");
    expect((await db.refunds.get(r.id))!.syncState).toBe("pending");
    const unauthorised = (async () =>
      new Response("{}", { status: 401 })) as unknown as typeof fetch;
    expect((await drainOutbox(db, ORG, { fetchFn: unauthorised, force: true })).state).toBe(
      "signed-out",
    );
  });
});

describe("receipts", () => {
  const header = {
    name: "Corner Shop",
    legalName: "Corner Shop Ltd",
    vatNumber: "IE1234567T",
    address: "1 Main St",
    eircode: "D01 X2Y3",
    receiptFooter: "Thank you",
    timezone: "Europe/Dublin",
  };

  it("prints the sale's barcode line last, as a barcode on ESC/POS and text in the browser", async () => {
    const sale = await sell();
    const receipt = buildReceipt({
      sale,
      priced,
      registerName: "Till 1",
      header,
      options: { warrantyEndDate: false, giftReceipt: false, allergens: false, tipLine: false },
    });
    const lines = receiptText(receipt, 42, receiptLabels());
    expect(lines.at(-1)).toBe(BARCODE_MARK + saleCode(sale.id));
    const bytes = encodeEscpos(lines);
    // GS k 73 (Code 128), length, "{B", then the code itself
    const at = bytes.findIndex(
      (b, i) => b === 0x1d && bytes[i + 1] === 0x6b && bytes[i + 2] === 0x49,
    );
    expect(at).toBeGreaterThan(0);
    expect(bytes[at + 3]).toBe(saleCode(sale.id).length + 2);
    expect(String.fromCharCode(...bytes.slice(at + 6, at + 6 + saleCode(sale.id).length))).toBe(
      saleCode(sale.id),
    );
    // the marker character never reaches the printer as text: the only 0x01 is the centring command
    expect(bytes.slice(0, at).filter((b) => b === 0x01)).toHaveLength(1);
  });

  it("prints a refund receipt with the original rate, the reason, the legs and the original number", async () => {
    const sale = await sell();
    const detail = detailOfLocalSale(sale, priced, "Till 1");
    const pricedRefund = priceRefundLines(detail, [
      { lineNo: 1, qty: 1, restock: true },
      { lineNo: 2, qty: 1, restock: false },
    ]);
    if (!pricedRefund.ok) throw new Error("pricing failed");
    const refund = await completeRefund(db, {
      registerId: REG,
      cashierUserId: CASHIER,
      originalSaleId: sale.id,
      originalReceiptNo: "Till 1 · 000001",
      kind: "refund",
      reasonCode: "other",
      reasonNote: "Bottle leaked",
      lines: pricedRefund.lines,
      legs: [
        {
          id: "00000000-0000-7000-a000-000000000009",
          typeId: CARD,
          method: "card",
          amountCents: pricedRefund.totals.total,
          tipCents: 0,
          reference: "RFD 77",
          label: "Card",
        },
      ],
      roundCash: true,
      roundingCents: 0,
      expectedAmountCents: pricedRefund.totals.total,
    });
    const receipt = buildRefundReceipt({ refund, registerName: "Till 1", header });
    expect(receipt).toMatchObject({
      kind: "refund",
      number: "Till 1 · R000001",
      originalNumber: "Till 1 · 000001",
      totalCents: 265,
      payoutCents: 265,
      vat: [{ rateBp: 2300, vatCents: pricedRefund.lines[0]!.vat }],
    });
    expect(receipt.reason).toContain("Bottle leaked");
    const text = refundReceiptText(receipt, 42);
    expect(text.every((l) => l.length <= 42)).toBe(true);
    const joined = text.join("\n");
    expect(joined).toContain("REFUND");
    expect(joined).toContain("Till 1 · R000001");
    expect(joined).toContain("Till 1 · 000001");
    expect(joined).toContain("-€2.50");
    expect(joined).toContain("Re-turn deposit");
    expect(joined).toContain("RFD 77");
    expect(joined).toContain("VAT 23%");
    // thirty-two columns still fit
    expect(refundReceiptText(receipt, 32).every((l) => l.length <= 32)).toBe(true);
  });

  it("labels a void and an exchange, shows the credit and the cash rounding", async () => {
    const sale = await sell([cash(5000)]);
    const detail = detailOfLocalSale(sale, priced, "Till 1");
    const all = priceRefundLines(
      detail,
      detail.lines.map((l) => ({ lineNo: l.line_no, qty: l.qty, restock: true })),
    );
    if (!all.ok) throw new Error("pricing failed");
    const make = (kind: "void" | "exchange") =>
      completeRefund(db, {
        registerId: REG,
        cashierUserId: CASHIER,
        originalSaleId: sale.id,
        originalReceiptNo: "Till 1 · 000001",
        kind,
        reasonCode: kind === "void" ? "void_mistake" : "wrong_item",
        lines: all.lines,
        legs: [],
        creditCents: kind === "exchange" ? all.totals.total : 0,
        exchangeSaleId: kind === "exchange" ? "00000000-0000-7000-8000-00000000abcd" : undefined,
        roundCash: true,
        roundingCents: 2,
        expectedAmountCents: 0,
      });
    const voided = refundReceiptText(
      buildRefundReceipt({ refund: await make("void"), registerName: "Till 1", header }),
      42,
    ).join("\n");
    expect(voided).toContain("VOID");
    expect(voided).toContain("Rounding");
    const exchanged = refundReceiptText(
      buildRefundReceipt({ refund: await make("exchange"), registerName: "Till 1", header }),
      42,
    ).join("\n");
    expect(exchanged).toContain("EXCHANGE RETURN");
    expect(exchanged).toContain("Exchange credit");
  });
});

describe("types", () => {
  it("LocalSale keeps the exchange refund it depends on", async () => {
    const sale: LocalSale = await sell();
    await db.sales.update(sale.id, { exchangeRefundId: "r1" });
    expect((await db.sales.get(sale.id))!.exchangeRefundId).toBe("r1");
  });
});
