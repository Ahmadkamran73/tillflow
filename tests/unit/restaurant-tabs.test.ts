import "fake-indexeddb/auto";
import Dexie from "dexie";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cartReducer,
  lineTotal,
  priceCart,
  serviceLinesOf,
  type Cart,
  type CartLine,
} from "@/lib/register/cart";
import { RegisterDb } from "@/lib/register/db";
import { buildReceipt, receiptText, receiptLabels } from "@/lib/register/receipt";
import { detailOfLocalSale } from "@/lib/register/refund";
import { priceRefundLines } from "@/lib/sync/refund-price";
import {
  closeTab,
  mergeTabs,
  openTab,
  pendingSend,
  qtysBySeat,
  recordSend,
  splitCart,
  splitTab,
  type WholeBill,
  tableStatus,
  transferTab,
} from "@/lib/register/tabs";
import { drainOutbox } from "@/lib/sync/outbox";
import { buildSaleRecord } from "@/lib/sync/sale-record";
import { serviceChargeWithin, settleTenders } from "@/lib/money";
import { IRISH_RATES } from "./money/irish-rates";

const ORG = "00000000-0000-4000-8000-0000000000f2";
const REG = "00000000-0000-4000-8000-0000000000e2";
const CASHIER = "00000000-0000-4000-8000-0000000000d2";
const ctx = { country: "IE", date: "2026-10-10", rates: IRISH_RATES };

const line = (id: string, over: Partial<CartLine> = {}): CartLine => ({
  id,
  variantId: `00000000-0000-4000-8000-00000000000${id}`,
  productId: "p",
  name: `Item ${id}`,
  unitPriceCents: 1000,
  modifiers: [],
  qty: 1,
  taxCategory: "CATERING",
  takeawayTaxCategory: "CATERING",
  depositCents: 0,
  ...over,
});
const cart = (lines: CartLine[], over: Partial<Cart> = {}): Cart => ({
  ageChecked: true,
  lines,
  ...over,
});

let db: RegisterDb;
beforeEach(async () => {
  await Dexie.delete(`tillflow-${ORG}`);
  db = new RegisterDb(ORG);
});

describe("pendingSend", () => {
  const tab = (lines: CartLine[], firedCourse = 0) => ({ cart: cart(lines), firedCourse });
  it("send releases course 1 and holds the rest; fire releases the next waiting course", () => {
    const t = tab([line("1", { course: 1 }), line("2", { course: 2 }), line("3", { course: 3 })]);
    expect(pendingSend(t, false)?.lines.map((l) => l.id)).toEqual(["1"]);
    expect(pendingSend(t, true)?.course).toBe(1);
    const fired = tab([line("1", { course: 1, sentAt: "x" }), line("2", { course: 2 })], 1);
    expect(pendingSend(fired, true)).toMatchObject({ course: 2 });
    expect(pendingSend(fired, false)).toBeNull(); // course 2 is still held
  });
  it("lines without a course are course 1; nothing waiting means nothing to send", () => {
    expect(pendingSend(tab([line("1")]), false)?.lines).toHaveLength(1);
    expect(pendingSend(tab([line("1", { sentAt: "x" })]), false)).toBeNull();
    expect(pendingSend(tab([line("1")], 1), true)).toBeNull();
  });
});

const wholeOf = (c: Cart): WholeBill => {
  const priced = priceCart(c, ctx);
  return {
    lineGross: c.lines.map((_, i) => lineTotal(priced, priced.itemIndex[i]!)),
    serviceCents: priced.basket.serviceChargeTotal,
  };
};
const split = (c: Cart, qtys: number[][], parts: number) => splitCart(c, qtys, parts, wholeOf(c));

describe("splitCart", () => {
  const base = cart([line("1", { qty: 2 }), line("2", { seat: 2 }), line("3", { seat: 1 })]);
  it("splits by item and keeps every unit", () => {
    const r = split(
      base,
      [
        [1, 1],
        [0, 1],
        [1, 0],
      ],
      2,
    );
    expect(r.ok && r.carts.map((c) => c.lines.reduce((s, l) => s + l.qty, 0))).toEqual([2, 2]);
  });
  it("by seat gives each seat its own lines", () => {
    const s = qtysBySeat(base);
    expect(s.seats).toEqual([1, 2]);
    expect(split(base, s.qtys, 2).ok).toBe(true);
  });
  it("refuses wrong quantities, empty parts and bad part counts", () => {
    expect(
      split(
        base,
        [
          [1, 0],
          [0, 1],
          [1, 0],
        ],
        2,
      ),
    ).toEqual({ ok: false, error: "bad_quantities" });
    expect(
      split(
        base,
        [
          [2, 0],
          [1, 0],
          [1, 0],
        ],
        2,
      ),
    ).toEqual({ ok: false, error: "empty_part" });
    expect(split(base, [[1, 1]], 2)).toEqual({ ok: false, error: "bad_quantities" });
    expect(
      split(
        base,
        [
          [1.5, 0.5],
          [1, 0],
          [1, 0],
        ],
        2,
      ),
    ).toEqual({ ok: false, error: "bad_quantities" });
    expect(split(base, [], 1)).toEqual({ ok: false, error: "too_many_parts" });
  });
  it("shares fixed-amount discounts and the basket discount exactly", () => {
    const c = cart(
      [line("1", { qty: 3, unitPriceCents: 105, discount: { amount: 100 } }), line("2")],
      {
        discount: { amount: 51 },
      },
    );
    const r = split(
      c,
      [
        [1, 2],
        [1, 0],
      ],
      2,
    );
    if (!r.ok) throw new Error("split failed");
    const whole = priceCart(c, ctx).basket;
    const parts = r.carts.map((p) => priceCart(p, ctx).basket);
    expect(parts.reduce((s, b) => s + b.itemsTotal, 0)).toBe(whole.itemsTotal);
  });
});

describe("a split bill reconciles with the whole bill to the cent", () => {
  // Deterministic pseudo-random bills: percent and amount discounts on lines and the basket,
  // deposits, mixed VAT categories, a service charge, every kind of split.
  let seed = 20261010;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return Math.floor((seed / 2 ** 31) * n);
  };
  const categories = ["CATERING", "STANDARD", "SECOND_REDUCED"] as const;

  function randomBill(): Cart {
    const lines = Array.from({ length: 1 + rnd(5) }, (_, i) => {
      const qty = 1 + rnd(4);
      const unit = 50 + rnd(3000);
      const kind = rnd(4);
      return line(String(i + 1), {
        qty,
        unitPriceCents: unit,
        taxCategory: categories[rnd(3)]!,
        depositCents: rnd(5) === 0 ? 15 : 0,
        seat: 1 + rnd(3),
        discount:
          kind === 0
            ? { percentBp: rnd(2500) }
            : kind === 1
              ? { amount: rnd(Math.min(unit * qty, 400)) }
              : undefined,
      });
    });
    return cart(lines, {
      serviceBp: [0, 1000, 1250, 1500][rnd(4)],
      discount: rnd(3) === 0 ? { percentBp: rnd(1500) } : undefined,
    });
  }

  function check(c: Cart, qtys: number[][], parts: number) {
    const whole = priceCart(c, ctx).basket;
    const r = split(c, qtys, parts);
    if (!r.ok) throw new Error(`split failed: ${r.error}`);
    const bs = r.carts.map((p) => priceCart(p, ctx).basket);
    const sum = (f: (b: (typeof bs)[number]) => number) => bs.reduce((s, b) => s + f(b), 0);
    // Food and drink, service charge, deposits and the total: exactly the whole bill's.
    expect(sum((b) => b.itemsTotal - b.serviceChargeTotal)).toBe(
      whole.itemsTotal - whole.serviceChargeTotal,
    );
    expect(sum((b) => b.serviceChargeTotal)).toBe(whole.serviceChargeTotal);
    expect(sum((b) => b.nonVatTotal)).toBe(whole.nonVatTotal);
    expect(sum((b) => b.total)).toBe(whole.total);
    // Every unit is rung up exactly once.
    expect(r.carts.flatMap((p) => p.lines).reduce((s, l) => s + l.qty, 0)).toBe(
      c.lines.reduce((s, l) => s + l.qty, 0),
    );
    // VAT is worked out on each part's own receipt: the bill splits to the cent, VAT within a cent a line.
    expect(Math.abs(sum((b) => b.vatTotal) - whole.vatTotal)).toBeLessThanOrEqual(
      (c.lines.length + 3) * parts,
    );
    // Each part's fixed charge is something the server accepts for that part's own food.
    r.carts.forEach((p, i) => {
      if (p.serviceCents !== undefined)
        expect(
          serviceChargeWithin(bs[i]!.serviceChargeBase, c.serviceBp ?? 0, p.serviceCents),
        ).toBe(true);
    });
  }

  it("by seat, by item and into two bills, over 400 random bills", () => {
    for (let n = 0; n < 400; n++) {
      const c = randomBill();
      const bySeat = qtysBySeat(c);
      if (bySeat.seats.length >= 2) check(c, bySeat.qtys, bySeat.seats.length);
      // by item: every unit of every line to a random one of two or three parts
      const parts = 2 + rnd(2);
      const qtys = c.lines.map((l) => {
        const row = Array<number>(parts).fill(0);
        for (let u = 0; u < l.qty; u++) row[rnd(parts)]!++;
        return row;
      });
      if (Array.from({ length: parts }, (_, p) => qtys.some((row) => row[p]! > 0)).every(Boolean))
        check(c, qtys, parts);
    }
  });

  it("the same bill always splits the same way (ties go to the earlier part)", () => {
    const c = cart([line("1", { qty: 3, unitPriceCents: 1001 })], { serviceBp: 1250 });
    const a = split(c, [[1, 1, 1]], 3);
    const b = split(c, [[1, 1, 1]], 3);
    if (!a.ok || !b.ok) throw new Error("split failed");
    expect(a.carts.map((p) => p.serviceCents)).toEqual(b.carts.map((p) => p.serviceCents));
    // 3 x 10.01 = 30.03, 12.5% = 3.75375 -> 375: shared 125 / 125 / 125
    expect(a.carts.map((p) => p.serviceCents)).toEqual([125, 125, 125]);
  });

  it("a take-away bill carries no charge into its parts", () => {
    const c = cart([line("1", { qty: 2, takeawayTaxCategory: "CATERING" })], {
      serviceBp: 1000,
      mode: "take_away",
    });
    const r = split(c, [[1, 1]], 2);
    expect(r.ok && r.carts.map((p) => p.serviceCents)).toEqual([0, 0]);
  });

  it("any edit to a part clears its fixed share", () => {
    const c = cart([line("1"), line("2")], { serviceBp: 1000 });
    const r = split(
      c,
      [
        [1, 0],
        [0, 1],
      ],
      2,
    );
    if (!r.ok) throw new Error("split failed");
    const part = r.carts[0]!;
    expect(part.serviceCents).toBeDefined();
    expect(cartReducer(part, { type: "qty", id: "1", delta: 1 }).serviceCents).toBeUndefined();
    expect(cartReducer(part, { type: "service", bp: 1000 }).serviceCents).toBeDefined();
  });
});

describe("tabs on the device", () => {
  const table = { id: "t1", name: "T1" };
  const open = () =>
    openTab(db, { registerId: REG, table, covers: 4, serviceBp: 1250, cashierUserId: CASHIER });

  it("opens a tab and queues one open event; the table is seated, then ordered", async () => {
    const tab = await open();
    expect(await db.tabEvents.toArray()).toMatchObject([
      { kind: "open", tabId: tab.rootId, detail: { table: "T1", covers: 4 }, syncState: "pending" },
    ]);
    expect(tableStatus([tab])).toBe("seated");
    expect(tableStatus([{ ...tab, cart: cart([line("1")]) }])).toBe("ordered");
    expect(tableStatus([{ ...tab, billAt: "x" }])).toBe("bill");
    expect(tableStatus([])).toBe("free");
  });

  it("send marks lines as sent and a sent line cannot change", async () => {
    const tab = { ...(await open()), cart: cart([line("1"), line("2", { course: 2 })]) };
    const next = pendingSend(tab, false)!;
    const saved = await recordSend(db, tab, {
      cashierUserId: CASHIER,
      course: next.course,
      lineIds: next.lines.map((l) => l.id),
      fire: false,
    });
    expect(saved.cart.lines.map((l) => !!l.sentAt)).toEqual([true, false]);
    expect(saved.firedCourse).toBe(1);
    expect((await db.tabEvents.toArray()).map((e) => e.kind)).toEqual(["open", "send"]);
  });

  it("split replaces the tab by parts that share its root; the close event goes with the last part", async () => {
    const tab = { ...(await open()), cart: cart([line("1", { seat: 1 }), line("2", { seat: 2 })]) };
    const r = splitCart(tab.cart, qtysBySeat(tab.cart).qtys, 2, wholeOf(tab.cart));
    if (!r.ok) throw new Error("split failed");
    const parts = await splitTab(db, tab, r.carts);
    expect(await db.tabs.count()).toBe(2);
    expect(new Set(parts.map((p) => p.rootId))).toEqual(new Set([tab.rootId]));
    expect(parts.every((p) => p.billAt && p.splitFrom === tab.id)).toBe(true);
    await closeTab(db, parts[0]!, { cashierUserId: CASHIER });
    expect((await db.tabEvents.toArray()).map((e) => e.kind)).toEqual(["open"]);
    await closeTab(db, parts[1]!, { cashierUserId: CASHIER });
    expect((await db.tabEvents.toArray()).map((e) => e.kind)).toEqual(["open", "close"]);
  });

  it("transfer moves the table; merge adds the lines and guests and removes the source", async () => {
    const a = { ...(await open()), cart: cart([line("1")]) };
    await db.tabs.put(a);
    const b = await openTab(db, {
      registerId: REG,
      table: { id: "t2", name: "T2" },
      covers: 2,
      serviceBp: 0,
      cashierUserId: CASHIER,
    });
    await transferTab(db, a, { id: "t3", name: "T3" }, { cashierUserId: CASHIER });
    expect((await db.tabs.get(a.id))?.tableName).toBe("T3");
    const merged = await mergeTabs(
      db,
      { ...b, cart: cart([line("2")]) },
      { ...a, tableName: "T3" },
      {
        cashierUserId: CASHIER,
      },
    );
    expect(merged.covers).toBe(6);
    expect(merged.cart.lines.map((l) => l.id)).toEqual(["1", "2"]);
    expect(await db.tabs.get(b.id)).toBeUndefined();
    const kinds = (await db.tabEvents.toArray()).map((e) => e.kind);
    expect(kinds.filter((k) => k === "transfer" || k === "merge").sort()).toEqual([
      "merge",
      "transfer",
    ]);
  });

  it("tab events sync after the sales, are removed when recorded, and a rejected one stays flagged", async () => {
    const tab = await open();
    const calls: string[] = [];
    const fetchFn = (async (url: string, init: { body: string }) => {
      calls.push(url);
      const events = (JSON.parse(init.body) as { events: { id: string }[] }).events;
      return Response.json({
        results: events.map((e) => ({
          id: e.id,
          status: e.id === tab.rootId ? "rejected" : "recorded",
        })),
      });
    }) as unknown as typeof fetch;
    await recordSend(
      db,
      { ...tab, cart: cart([line("1")]) },
      {
        cashierUserId: CASHIER,
        course: 1,
        lineIds: ["1"],
        fire: false,
      },
    );
    const r = await drainOutbox(db, ORG, { fetchFn, force: true });
    expect(r.state).toBe("idle");
    expect(calls).toEqual(["/api/v1/sync/tabs"]);
    expect(await db.tabEvents.count()).toBe(0); // both recorded
  });
});

describe("the service charge on a bill", () => {
  const bill = cart(
    [
      line("1", { unitPriceCents: 1850, seat: 1 }),
      line("2", { unitPriceCents: 650, taxCategory: "STANDARD", seat: 1 }),
    ],
    {
      serviceBp: 1250,
    },
  );
  const priced = priceCart(bill, ctx);

  it("becomes taxed item lines in the record, after the items, that add up to the sale", () => {
    const settlement = settleTenders(priced.basket.total, [
      { method: "card", amount: priced.basket.total },
    ]);
    const rec = buildSaleRecord({
      orgId: "o",
      registerId: "r",
      userId: "u",
      sale: {
        id: "00000000-0000-7000-8000-000000000001",
        cashierUserId: CASHIER,
        receiptSeq: 1,
        completedAt: "2026-10-10T12:00:00.000Z",
        mode: "eat_in",
        serviceChargeBp: 1250,
        lines: [],
        tenders: [],
        roundCash: false,
        expectedDueCents: priced.basket.total,
      },
      cart: bill,
      priced,
      settlement,
      pricedAsOf: new Date("2026-10-10T12:00:00.000Z"),
    });
    const items = rec.lines.filter((l) => l.kind === "item");
    // Each item is followed by its own service line, with the item's quantity and rate.
    expect(items.map((l) => l.variant_id === null)).toEqual([false, true, false, true]);
    expect(serviceLinesOf(priced)).toHaveLength(2);
    items.forEach((l, i) => {
      if (l.variant_id !== null) return;
      const item = items[i - 1]!;
      expect(l.qty).toBe(item.qty);
      expect(l.tax_rate_bp).toBe(item.tax_rate_bp);
      expect(l.name).toBe("Service charge 12.5%");
      expect((l.unit_price_cents as number) * (l.qty as number) - (l.gross_cents as number)).toBe(
        l.discount_cents,
      );
    });
    const sum = (k: string) => items.reduce((s, l) => s + (l[k] as number), 0);
    expect(sum("gross_cents")).toBe(rec.sale.items_total);
    expect(sum("vat_cents")).toBe(rec.sale.vat);
    for (const l of items)
      expect((l.net_cents as number) + (l.vat_cents as number)).toBe(l.gross_cents);
    expect(rec.sale.items_total).toBe(2500 + priced.basket.serviceChargeTotal);
  });

  it("prints on the receipt as its own line and is refundable like any item", () => {
    const sale = {
      id: "00000000-0000-7000-8000-000000000002",
      registerId: REG,
      receiptSeq: 7,
      completedAt: "2026-10-10T12:00:00.000Z",
      cart: bill,
      tenders: [
        {
          id: "x",
          typeId: null,
          method: "card" as const,
          amountCents: priced.basket.total,
          tipCents: 200,
          label: "Card",
        },
      ],
      roundCash: false,
    };
    const receipt = buildReceipt({
      sale,
      priced,
      registerName: "Till 1",
      header: {
        name: "Cafe",
        legalName: null,
        vatNumber: null,
        address: null,
        eircode: null,
        receiptFooter: null,
        timezone: "Europe/Dublin",
      },
      options: { warrantyEndDate: false, giftReceipt: false, allergens: false, tipLine: true },
    });
    expect(receipt.lines.slice(2).map((l) => l.name)[0]).toBe("Service charge 12.5%");
    expect(receipt.totalCents).toBe(priced.basket.total);
    const text = receiptText(receipt, 42, receiptLabels()).join("\n");
    expect(text).toContain("Service charge 12.5%");
    const detail = detailOfLocalSale(
      {
        ...sale,
        cashierUserId: CASHIER,
        syncState: "pending",
        attempts: 0,
        expectedDueCents: priced.basket.total,
      },
      priced,
      "Till 1",
    );
    // Each service line sits right after the item it was charged on.
    expect(detail.lines.map((l) => l.variant_id === null)).toEqual([false, true, false, true]);
    expect(detail.lines.map((l) => l.line_no)).toEqual([1, 2, 3, 4]);
    expect(detail.sale.items_total).toBe(priced.basket.itemsTotal);
    expect(detail.lines.reduce((s, l) => s + l.gross, 0)).toBe(priced.basket.total);
  });
});

describe("voiding a sent line", () => {
  it("only the void action removes a line already sent; Remove and the quantity buttons cannot", () => {
    const c = cart([line("1", { sentAt: "2026-10-10T12:00:00.000Z" }), line("2")]);
    expect(cartReducer(c, { type: "remove", id: "1" }).lines.map((l) => l.id)).toEqual(["1", "2"]);
    expect(cartReducer(c, { type: "qty", id: "1", delta: -1 }).lines).toHaveLength(2);
    expect(cartReducer(c, { type: "voidSent", id: "1" }).lines.map((l) => l.id)).toEqual(["2"]);
  });
});

describe("a split part keeps its fixed share", () => {
  it("tapping + on a sent line changes nothing, so the share stays", () => {
    const c = cart([line("1", { sentAt: "x" }), line("2")], { serviceBp: 1000, serviceCents: 40 });
    expect(cartReducer(c, { type: "qty", id: "1", delta: 1 }).serviceCents).toBe(40);
  });
});

describe("a partial refund returns the service charge pro rata", () => {
  const three = cart([line("1", { unitPriceCents: 1004, qty: 3, seat: 1 })], { serviceBp: 1250 });
  const pricedThree = priceCart(three, ctx);
  const detail = detailOfLocalSale(
    {
      id: "00000000-0000-7000-8000-0000000000aa",
      registerId: REG,
      receiptSeq: 1,
      completedAt: "2026-10-10T12:00:00.000Z",
      cart: three,
      tenders: [
        {
          id: "x",
          typeId: null,
          method: "card" as const,
          amountCents: pricedThree.basket.total,
          tipCents: 0,
          label: "Card",
        },
      ],
      roundCash: false,
      cashierUserId: CASHIER,
      syncState: "pending",
      attempts: 0,
      expectedDueCents: pricedThree.basket.total,
    },
    pricedThree,
    "Till 1",
  );

  it("one unit of three returns a third of the item and of its charge, at its own rate", () => {
    const service = detail.lines[1]!;
    expect(service.qty).toBe(3);
    const r = priceRefundLines(detail, [
      { lineNo: 1, qty: 1, restock: true },
      { lineNo: 2, qty: 1, restock: false },
    ]);
    if (!r.ok) throw new Error("refund failed");
    const [item, charge] = r.lines;
    expect(item!.gross).toBe(1004);
    expect(charge!.gross).toBe(Math.round(service.gross / 3));
    expect(charge!.rateBp).toBe(item!.rateBp);
    expect(r.totals.itemsTotal).toBe(item!.gross + charge!.gross);
  });

  it("refunding the units in any order adds up to the whole item and the whole charge, to the cent", () => {
    const parts = [1, 1, 1].map((_, k) => {
      const withEarlier = {
        ...detail,
        lines: detail.lines.map((l) => ({ ...l, refunded_qty: k })),
      };
      const r = priceRefundLines(withEarlier, [
        { lineNo: 1, qty: 1, restock: true },
        { lineNo: 2, qty: 1, restock: false },
      ]);
      if (!r.ok) throw new Error("refund failed");
      return r;
    });
    const sum = (f: (r: (typeof parts)[number]) => number) => parts.reduce((s, r) => s + f(r), 0);
    expect(sum((r) => r.lines[0]!.gross)).toBe(detail.lines[0]!.gross);
    expect(sum((r) => r.lines[1]!.gross)).toBe(detail.lines[1]!.gross);
    expect(sum((r) => r.lines[1]!.vat)).toBe(detail.lines[1]!.vat ?? 0);
  });
});
