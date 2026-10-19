import { describe, expect, it } from "vitest";
import { settleTenders } from "@/lib/money";
import { priceCart, type Cart, type CartLine } from "@/lib/register/cart";
import { syncRejectionReasons } from "@/db/schema/sales";
import { rowsFromAsOf } from "@/lib/sync/as-of";
import { SYNC_REASONS, syncBatch, syncSale } from "@/lib/sync/protocol";
import { buildSaleRecord } from "@/lib/sync/sale-record";
import { IRISH_RATES } from "./money/irish-rates";

const line = (over: Partial<CartLine> = {}): CartLine => ({
  id: "0",
  variantId: "00000000-0000-4000-8000-000000000001",
  productId: "00000000-0000-4000-8000-0000000000a1",
  name: "Tea bags",
  unitPriceCents: 1234,
  modifiers: [],
  qty: 1,
  taxCategory: "STANDARD",
  takeawayTaxCategory: null,
  depositCents: 0,
  ...over,
});

const record = (cart: Cart, tendered = 5000) => {
  const priced = priceCart(cart, { country: "IE", date: "2026-10-06", rates: IRISH_RATES });
  const settlement = settleTenders(priced.basket.total, [{ method: "cash", amount: tendered }]);
  const due = settlement.amountDue;
  const rec = buildSaleRecord({
    orgId: "o",
    registerId: "r",
    userId: "u",
    sale: {
      id: "00000000-0000-7000-8000-000000000001",
      cashierUserId: "00000000-0000-4000-8000-0000000000d1",
      receiptSeq: 1,
      completedAt: "2026-10-06T12:00:00.000Z",
      mode: "eat_in",
      serviceChargeBp: 0,
      lines: [],
      tenders: [
        {
          id: "00000000-0000-7000-9000-000000000001",
          typeId: null,
          method: "cash",
          amountCents: tendered,
          tipCents: 0,
        },
      ],
      roundCash: true,
      expectedDueCents: due,
    },
    cart,
    priced,
    settlement,
    pricedAsOf: new Date("2026-10-06T12:00:00.000Z"),
  });
  return { rec, priced };
};

describe("buildSaleRecord", () => {
  it("lines reconcile to the basket: gross, VAT and total", () => {
    const cart: Cart = {
      ageChecked: true,
      discount: { percentBp: 1000 },
      lines: [
        line({ qty: 3, discount: { amount: 100 } }),
        line({
          id: "1",
          unitPriceCents: 595,
          taxCategory: "CATERING",
          takeawayTaxCategory: "ZERO",
          modifiers: [{ id: "m", name: "Oat", priceDeltaCents: 50 }],
          serial: "SN1",
        }),
        line({ id: "2", unitPriceCents: 249, depositCents: 15, qty: 4 }),
      ],
    };
    const { rec, priced } = record(cart);
    const items = rec.lines.filter((l) => l.kind === "item");
    const deposits = rec.lines.filter((l) => l.kind === "deposit");
    const sum = (ls: Record<string, unknown>[], k: string) =>
      ls.reduce((s, l) => s + (l[k] as number), 0);

    expect(sum(items, "gross_cents")).toBe(priced.basket.itemsTotal);
    expect(sum(items, "vat_cents")).toBe(priced.basket.vatTotal);
    expect(sum(items, "net_cents") + sum(items, "vat_cents")).toBe(priced.basket.itemsTotal);
    expect(sum(deposits, "gross_cents")).toBe(priced.basket.nonVatTotal);
    expect(rec.sale.items_total + rec.sale.non_vat + rec.sale.cash_rounding).toBe(
      rec.sale.amount_due,
    );
    expect(rec.payments).toHaveLength(1);
    expect(rec.payments[0]).toMatchObject({ amount: rec.sale.amount_due, tendered: 5000 });
    expect(rec.payments[0]!.change).toBe(5000 - rec.sale.amount_due);
    expect(items[1]).toMatchObject({ serial: "SN1", unit_price_cents: 645 });
    expect(deposits[0]).toMatchObject({ kind: "deposit", qty: 4, unit_price_cents: 15 });
  });

  it("copies the VAT rate onto each line; deposits carry none", () => {
    const { rec } = record({ ageChecked: true, lines: [line({ depositCents: 15 })] });
    expect(rec.lines[0]).toMatchObject({ tax_category: "STANDARD", tax_rate_bp: 2300 });
    expect(rec.lines[1]).not.toHaveProperty("tax_rate_bp");
  });

  it("discount_cents is what the line lost to line and basket discounts", () => {
    const { rec } = record({
      ageChecked: true,
      lines: [line({ unitPriceCents: 1000, qty: 2, discount: { amount: 200 } })],
    });
    expect(rec.lines[0]).toMatchObject({ discount_cents: 200, gross_cents: 1800 });
  });

  it("refuses to record when the tender does not cover the amount due", () => {
    expect(() => record({ ageChecked: true, lines: [line()] }, 100)).toThrow(RangeError);
  });
});

describe("protocol", () => {
  it("the reason list matches the database schema", () => {
    expect([...SYNC_REASONS]).toEqual([...syncRejectionReasons]);
  });

  it("a batch holds at most 25 sales and no extra keys", () => {
    const id = "00000000-0000-4000-8000-0000000000e1";
    expect(syncBatch.safeParse({ registerId: id, sales: [] }).success).toBe(true);
    expect(syncBatch.safeParse({ registerId: id, sales: Array(26).fill({}) }).success).toBe(false);
    expect(syncBatch.safeParse({ registerId: id, sales: [], extra: 1 }).success).toBe(false);
  });

  it("a sale takes only inputs: unknown keys (such as a client total) are refused", () => {
    const ok = {
      id: "00000000-0000-7000-8000-000000000001",
      cashierUserId: "00000000-0000-4000-8000-0000000000d1",
      receiptSeq: 1,
      completedAt: "2026-10-06T12:00:00.000Z",
      lines: [{ variantId: "00000000-0000-4000-8000-000000000001", qty: 1, modifierIds: [] }],
      tenders: [
        {
          id: "00000000-0000-7000-9000-000000000001",
          typeId: null,
          method: "cash",
          amountCents: 100,
        },
      ],
      expectedDueCents: 100,
    };
    expect(syncSale.safeParse(ok).success).toBe(true);
    // The old shape (one cash amount) is still read, as a single cash payment.
    const { tenders: _t, ...rest } = ok;
    void _t;
    expect(syncSale.safeParse({ ...rest, tenderedCents: 100 }).success).toBe(true);
    expect(syncSale.safeParse({ ...ok, totalCents: 1 }).success).toBe(false);
    expect(syncSale.safeParse({ ...ok, lines: [] }).success).toBe(false);
    expect(syncSale.safeParse({ ...ok, expectedDueCents: 1.5 }).success).toBe(false);
  });
});

describe("rowsFromAsOf", () => {
  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  it("maps the SQL result and takes a product's VAT category from its variants", () => {
    const rows = rowsFromAsOf({
      variants: [
        {
          id: U(1),
          product_id: U(10),
          name: "",
          price_cents: 500,
          tax_category: "CATERING",
          takeaway_tax_category: "ZERO",
          attributes: { depositCents: 0 },
        },
      ],
      products: [{ id: U(10), name: "Coffee", track_stock: true }],
      modifiers: [{ id: U(20), group_id: U(30), name: "Oat", price_delta_cents: 50 }],
      product_groups: [{ product_id: U(10), group_id: U(30) }],
    });
    expect(rows.products).toEqual([
      { id: U(10), name: "Coffee", taxCategory: "CATERING", takeawayTaxCategory: "ZERO" },
    ]);
    expect(rows.variants[0]).toMatchObject({ id: U(1), productId: U(10), priceCents: 500 });
    expect(rows.modifiers[0]).toMatchObject({ groupId: U(30), priceDeltaCents: 50 });
    expect(rows.productGroups).toEqual([{ productId: U(10), groupId: U(30) }]);
  });

  it("drops a variant whose product is missing and rejects malformed rows", () => {
    const rows = rowsFromAsOf({
      variants: [
        {
          id: U(1),
          product_id: U(10),
          name: "",
          price_cents: 1,
          tax_category: "ZERO",
          takeaway_tax_category: null,
          attributes: {},
        },
      ],
      products: [],
      modifiers: [],
      product_groups: [],
    });
    expect(rows.variants).toEqual([]);
    expect(() => rowsFromAsOf({ variants: "x" })).toThrow();
  });
});
