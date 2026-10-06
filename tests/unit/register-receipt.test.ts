import { describe, expect, it } from "vitest";
import { presets } from "@/config/business-type-presets";
import { priceCart, type Cart, type CartLine } from "@/lib/register/cart";
import type { ReceiptSale } from "@/lib/register/db";
import { encodeEscpos, DRAWER_KICK } from "@/lib/register/print/escpos";
import { invoiceInput } from "@/lib/register/invoice";
import {
  addMonths,
  buildReceipt,
  receiptLabels,
  receiptText,
  type ReceiptHeader,
} from "@/lib/register/receipt";
import { LOCAL_BRIDGE } from "@/lib/register/print/bridge";
import { receiptNo } from "@/lib/register/sale";
import { buildServerCart, emailReceiptInput, SaleError } from "@/lib/register/sale-input";
import { IRISH_RATES } from "./money/irish-rates";

const ctx = { country: "IE", date: "2026-10-05", rates: IRISH_RATES };
const header: ReceiptHeader = {
  name: "Corner Shop",
  legalName: "Corner Shop Ltd",
  vatNumber: "IE6388047V",
  address: "1 Main Street, Dublin",
  eircode: "D01 AB12",
  receiptFooter: "Thank you!",
  timezone: "Europe/Dublin",
};

const line = (over: Partial<CartLine> = {}): CartLine => ({
  id: "l1",
  variantId: "v1",
  productId: "p1",
  name: "Tea bags",
  unitPriceCents: 1230,
  modifiers: [],
  qty: 1,
  taxCategory: "STANDARD",
  takeawayTaxCategory: null,
  depositCents: 0,
  ...over,
});

const saleOf = (lines: CartLine[], over: Partial<ReceiptSale> = {}): ReceiptSale => ({
  id: "s1",
  registerId: "r1",
  receiptSeq: 42,
  completedAt: "2026-10-05T13:32:00.000Z", // 14:32 in Dublin (IST)
  cart: { lines, ageChecked: false } satisfies Cart,
  tenderedCents: 5000,
  ...over,
});

const build = (sale: ReceiptSale, asInvoice = false, preset = presets.general) =>
  buildReceipt({
    sale,
    priced: priceCart(sale.cart, ctx),
    registerName: "Till 1",
    header,
    options: preset.receipt,
    asInvoice,
  });

describe("receiptNo", () => {
  it("pads the sequence per till", () => {
    expect(receiptNo("Till 1", 42)).toBe("Till 1 · 000042");
  });
});

describe("addMonths", () => {
  it("adds months and clamps to the month end", () => {
    expect(addMonths("2026-10-05", 12)).toBe("2027-10-05");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2027-12-31", 2)).toBe("2028-02-29");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
  });
});

describe("buildReceipt", () => {
  it("has the header, local time, lines, VAT summary, total and change", () => {
    const r = build(
      saleOf([line({ qty: 2 }), line({ id: "l2", name: "Milk", unitPriceCents: 150 })]),
    );
    expect(r.business).toEqual({
      name: "Corner Shop Ltd",
      vatNumber: "IE6388047V",
      address: ["1 Main Street, Dublin", "D01 AB12"],
    });
    expect(r.number).toBe("Till 1 · 000042");
    expect(r.dateTime).toBe("05/10/2026 14:32");
    expect(r.lines.map((l) => [l.name, l.qty, l.totalCents])).toEqual([
      ["Tea bags", 2, 2460],
      ["Milk", 1, 150],
    ]);
    expect(r.vat).toHaveLength(1);
    expect(r.vat[0]).toMatchObject({ rateBp: 2300, grossCents: 2610 });
    expect(r.vat[0]!.netCents + r.vat[0]!.vatCents).toBe(2610);
    expect(r.totalCents).toBe(2610);
    // 5c cash rounding is its own line and never changes the total
    expect(r.roundingCents).toBe(0);
    expect(r.dueCents).toBe(2610);
    expect(r.changeCents).toBe(5000 - 2610);
  });

  it("shows cash rounding as its own line and change from the rounded amount", () => {
    const r = build(saleOf([line({ unitPriceCents: 1234 })], { tenderedCents: 2000 }));
    expect(r.totalCents).toBe(1234);
    expect(r.roundingCents).toBe(1); // 12.34 → 12.35
    expect(r.dueCents).toBe(1235);
    expect(r.changeCents).toBe(765);
    const text = receiptText(r, 42, receiptLabels()).join("\n");
    expect(text).toContain("Cash rounding");
  });

  it("splits VAT by rate and keeps deposits outside VAT", () => {
    const r = build(
      saleOf([
        line({ unitPriceCents: 300, depositCents: 15 }),
        line({ id: "l2", name: "Bread", unitPriceCents: 220, taxCategory: "ZERO" }),
      ]),
    );
    expect(r.vat.map((v) => v.rateBp).sort()).toEqual([0, 2300]);
    expect(r.deposits).toEqual([{ name: "Tea bags", cents: 15 }]);
    expect(r.totalCents).toBe(300 + 15 + 220);
  });

  it("prints the warranty end date for electronics only", () => {
    const sale = saleOf([line({ name: "Phone", unitPriceCents: 59900, warrantyMonths: 24 })], {
      tenderedCents: 60000,
    });
    expect(build(sale, false, presets.electronics).lines[0]!.warrantyEnds).toBe("05/10/2028");
    expect(build(sale, false, presets.general).lines[0]!.warrantyEnds).toBeUndefined();
  });

  it("is a VAT invoice only when an invoice customer is attached and asked for", () => {
    const invoice = { name: "Acme Ltd", address: "5 Quay, Cork", vatNumber: "IE1234567T" };
    const sale = saleOf([line()], { invoice });
    expect(build(sale).kind).toBe("receipt");
    const r = build(sale, true);
    expect(r.kind).toBe("vat_invoice");
    expect(r.customer).toEqual(invoice);
    const text = receiptText(r, 42, receiptLabels()).join("\n");
    expect(text).toContain("VAT INVOICE");
    expect(text).toContain("IE1234567T");
    expect(r.lines[0]!.netCents + r.lines[0]!.vatCents).toBe(r.lines[0]!.totalCents);
  });

  it("refuses a tender below the amount due", () => {
    expect(() => build(saleOf([line()], { tenderedCents: 100 }))).toThrow(RangeError);
  });
});

describe("receiptText", () => {
  it.each([32, 42, 48] as const)("never overflows %i columns", (cols) => {
    const r = build(
      saleOf([
        line({
          name: "A very long product name that cannot possibly fit on one printed line",
          modifiers: [{ id: "m", name: "Extra shot of something long", priceDeltaCents: 50 }],
          serial: "SN-1234567890",
          qty: 3,
        }),
      ]),
    );
    const lines = receiptText(r, cols, receiptLabels());
    expect(lines.every((l) => l.length <= cols)).toBe(true);
    expect(lines.join("\n")).toContain("Corner Shop Ltd");
    expect(lines.join("\n")).toContain("Thank you!");
  });
});

describe("escpos", () => {
  it("frames text with init, code page, newline, cut and optional drawer kick", () => {
    const plain = [...encodeEscpos(["Hi €"])];
    expect(plain.slice(0, 5)).toEqual([0x1b, 0x40, 0x1b, 0x74, 19]);
    expect(plain.slice(5, 9)).toEqual([0x48, 0x69, 0x20, 0xd5]); // "Hi " + € in CP858
    expect(plain.slice(-4)).toEqual([0x1d, 0x56, 0x42, 0x00]);
    const kick = [...encodeEscpos(["x"], { kick: true })];
    expect(kick.slice(-DRAWER_KICK.length)).toEqual(DRAWER_KICK);
    expect([...encodeEscpos(["x"], { cut: false })]).not.toContain(0x56);
  });
});

describe("invoice input", () => {
  const ok = { name: "Acme", address: "Cork" };
  it("accepts Irish and EU VAT numbers, normalised", () => {
    expect(invoiceInput.parse({ ...ok, vatNumber: "ie 6388047 v" }).vatNumber).toBe("IE6388047V");
    expect(invoiceInput.parse({ ...ok, vatNumber: "DE123456789" }).vatNumber).toBe("DE123456789");
  });
  it("rejects bad numbers and blanks", () => {
    expect(invoiceInput.safeParse({ ...ok, vatNumber: "IE1234567A" }).success).toBe(false);
    expect(invoiceInput.safeParse({ ...ok, vatNumber: "12345" }).success).toBe(false);
    expect(
      invoiceInput.safeParse({ name: " ", address: "x", vatNumber: "DE123456789" }).success,
    ).toBe(false);
  });
});

describe("server re-pricing input", () => {
  const rows = {
    variants: [
      { id: "v1", productId: "p1", name: "", priceCents: 1230, attributes: { depositCents: 15 } },
    ],
    products: [{ id: "p1", name: "Tea", taxCategory: "STANDARD", takeawayTaxCategory: null }],
    modifiers: [{ id: "m1", groupId: "g1", name: "Oat", priceDeltaCents: 50 }],
    productGroups: [{ productId: "p1", groupId: "g1" }],
  };
  const l = (over = {}) => ({ variantId: "v1", qty: 2, modifierIds: [], ...over });

  it("takes prices, VAT category and deposit from the catalogue, never the client", () => {
    const cart = buildServerCart({ lines: [l({ modifierIds: ["m1"] })] }, rows);
    expect(cart.lines[0]).toMatchObject({
      unitPriceCents: 1230,
      taxCategory: "STANDARD",
      depositCents: 15,
      modifiers: [{ id: "m1", priceDeltaCents: 50 }],
    });
  });
  it("rejects unknown variants and modifiers the product does not offer", () => {
    expect(() => buildServerCart({ lines: [l({ variantId: "nope" })] }, rows)).toThrow(SaleError);
    const other = { ...rows, productGroups: [] };
    expect(() => buildServerCart({ lines: [l({ modifierIds: ["m1"] })] }, other)).toThrow(
      SaleError,
    );
  });
  it("rejects duplicate modifiers and a negative unit price", () => {
    expect(() => buildServerCart({ lines: [l({ modifierIds: ["m1", "m1"] })] }, rows)).toThrow(
      SaleError,
    );
    const cheap = { ...rows, modifiers: [{ ...rows.modifiers[0]!, priceDeltaCents: -5000 }] };
    expect(() => buildServerCart({ lines: [l({ modifierIds: ["m1"] })] }, cheap)).toThrow(
      SaleError,
    );
  });
  it("validates the request shape", () => {
    const base = {
      lines: [{ variantId: crypto.randomUUID(), qty: 1, modifierIds: [] }],
      expectedDueCents: 100,
      tenderedCents: 100,
      receiptSeq: 1,
      registerName: "Till 1",
      completedAt: "2026-10-05T13:32:00.000Z",
      to: "a@example.com",
    };
    expect(emailReceiptInput.safeParse(base).success).toBe(true);
    expect(emailReceiptInput.safeParse({ ...base, price: 1 }).success).toBe(false); // strict
    expect(emailReceiptInput.safeParse({ ...base, to: "nope" }).success).toBe(false);
    expect(
      emailReceiptInput.safeParse({
        ...base,
        lines: [{ ...base.lines[0], qty: 0 }],
      }).success,
    ).toBe(false);
  });
});

describe("print bridge address", () => {
  it("is only this computer", () => {
    expect(LOCAL_BRIDGE.test("http://127.0.0.1:9101")).toBe(true);
    expect(LOCAL_BRIDGE.test("http://localhost:9101/")).toBe(true);
    expect(LOCAL_BRIDGE.test("https://evil.example:9101")).toBe(false);
    expect(LOCAL_BRIDGE.test("http://127.0.0.1.evil.example:9101")).toBe(false);
    expect(LOCAL_BRIDGE.test("http://192.168.1.5:9101")).toBe(false);
  });
});

describe("discounts and service mode", () => {
  it("shows each line's discount (line and basket share) so printed lines reconcile", () => {
    const sale = saleOf([], {
      cart: {
        ageChecked: false,
        discount: { amount: 300 },
        lines: [
          line({ qty: 2, unitPriceCents: 1000, discount: { percentBp: 1000 } }),
          line({ id: "l2", name: "Milk", unitPriceCents: 500 }),
        ],
      },
    });
    const r = build(sale);
    expect(r.lines.reduce((s, l) => s + l.totalCents, 0)).toBe(r.totalCents);
    // full price 2500, 10% off the first line (200) and 300 off the basket
    expect(r.lines.reduce((s, l) => s + l.discountCents, 0)).toBe(2500 - r.totalCents);
    expect(r.totalCents).toBe(2000);
    expect(receiptText(r, 42, receiptLabels()).join("\n")).toContain("Discount -");
  });

  it("take-away changes the VAT: cold take-away food is 0%, eat-in is 9%", () => {
    const sandwich = line({
      name: "Sandwich",
      unitPriceCents: 400,
      taxCategory: "CATERING",
      takeawayTaxCategory: "ZERO",
    });
    const eatIn = build(saleOf([sandwich]));
    expect(eatIn.vat.map((v) => v.rateBp)).toEqual([900]);
    expect(eatIn.takeAway).toBe(false);
    const away = build(
      saleOf([sandwich], { cart: { lines: [sandwich], ageChecked: false, mode: "take_away" } }),
    );
    expect(away.vat.map((v) => v.rateBp)).toEqual([0]);
    expect(away.vat[0]!.vatCents).toBe(0);
    expect(away.takeAway).toBe(true);
    expect(receiptText(away, 42, receiptLabels()).join("\n")).toContain("TAKE AWAY");
  });

  it("the server cart carries the mode", () => {
    const rows = {
      variants: [{ id: "v1", productId: "p1", name: "", priceCents: 400, attributes: {} }],
      products: [
        { id: "p1", name: "Sandwich", taxCategory: "CATERING", takeawayTaxCategory: "ZERO" },
      ],
      modifiers: [],
      productGroups: [],
    };
    const lines = [{ variantId: "v1", qty: 1, modifierIds: [] }];
    expect(buildServerCart({ lines, mode: "take_away" }, rows).mode).toBe("take_away");
    expect(buildServerCart({ lines }, rows).mode).toBeUndefined();
  });
});
