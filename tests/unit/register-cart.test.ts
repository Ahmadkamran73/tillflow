import { describe, expect, it } from "vitest";
import { presets } from "@/config/business-type-presets";
import {
  cartReducer,
  emptyCart,
  lineTotal,
  priceCart,
  promptsFor,
  safePriceCart,
  type Cart,
  type CartLine,
} from "@/lib/register/cart";
import { IRISH_RATES } from "./money/irish-rates";

const ctx = { country: "IE", date: "2026-10-05", rates: IRISH_RATES };

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

const add = (cart: Cart, l: CartLine) => cartReducer(cart, { type: "add", line: l });

describe("cart reducer", () => {
  it("adding the same plain variant again gains a unit; modifiers or serials stay separate", () => {
    let c = add(emptyCart, line());
    c = add(c, line({ id: "l2" }));
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]!.qty).toBe(2);
    c = add(c, line({ id: "l3", serial: "SN12345" }));
    c = add(c, line({ id: "l4", modifiers: [{ id: "m", name: "Oat", priceDeltaCents: 50 }] }));
    expect(c.lines).toHaveLength(3);
  });

  it("minus on 1 removes the line; a fixed discount is dropped when the quantity changes", () => {
    let c = add(emptyCart, line({ qty: 2, discount: { amount: 100 } }));
    c = cartReducer(c, { type: "qty", id: "l1", delta: -1 });
    expect(c.lines[0]).toMatchObject({ qty: 1, discount: undefined });
    c = cartReducer(c, { type: "lineDiscount", id: "l1", discount: { percentBp: 1000 } });
    c = cartReducer(c, { type: "qty", id: "l1", delta: 1 });
    expect(c.lines[0]!.discount).toEqual({ percentBp: 1000 }); // percentages scale, so they stay
    c = cartReducer(c, { type: "qty", id: "l1", delta: -1 });
    c = cartReducer(c, { type: "qty", id: "l1", delta: -1 });
    expect(c.lines).toHaveLength(0);
  });

  it("remove, basket discount and load", () => {
    let c = add(emptyCart, line());
    c = cartReducer(c, { type: "basketDiscount", discount: { percentBp: 500 } });
    expect(c.discount).toEqual({ percentBp: 500 });
    c = cartReducer(c, { type: "remove", id: "l1" });
    expect(c.lines).toHaveLength(0);
    expect(cartReducer(c, { type: "load", cart: emptyCart })).toBe(emptyCart);
  });
});

describe("priceCart (display figures come from the money library)", () => {
  it("prices a VAT-inclusive line and splits the 23% VAT", () => {
    const { basket } = priceCart(add(emptyCart, line()), ctx, "card");
    expect(basket.total).toBe(1230);
    expect(basket.vatByRate).toEqual([{ rateBp: 2300, gross: 1230, net: 1000, vat: 230 }]);
  });

  it("modifier deltas join the unit price and the product's VAT category", () => {
    const c = add(
      emptyCart,
      line({
        taxCategory: "CATERING",
        takeawayTaxCategory: "CATERING",
        modifiers: [{ id: "m", name: "Extra shot", priceDeltaCents: 60 }],
        unitPriceCents: 340,
      }),
    );
    const { basket } = priceCart(c, ctx, "card");
    expect(basket.total).toBe(400);
    expect(basket.vatByRate.map((r) => r.rateBp)).toEqual([900]);
  });

  it("a deposit is its own non-VAT line and lineTotal ignores it", () => {
    const c = add(emptyCart, line({ qty: 2, depositCents: 15 }));
    const priced = priceCart(c, ctx, "card");
    expect(priced.basket.nonVatTotal).toBe(30);
    expect(lineTotal(priced, priced.itemIndex[0]!)).toBe(2460);
    expect(priced.basket.total).toBe(2490);
  });

  it("cash gets 5c rounding, card does not", () => {
    const c = add(emptyCart, line({ unitPriceCents: 1233 }));
    expect(priceCart(c, ctx, "cash").basket.cashRounding).toBe(2);
    expect(priceCart(c, ctx, "card").basket.cashRounding).toBe(0);
  });

  it("line and basket discounts apply before VAT and the totals reconcile", () => {
    let c = add(emptyCart, line({ discount: { percentBp: 1000 } }));
    c = add(c, line({ id: "l2", variantId: "v2", unitPriceCents: 500 }));
    c = cartReducer(c, { type: "basketDiscount", discount: { amount: 100 } });
    const { basket } = priceCart(c, ctx, "card");
    expect(basket.total).toBe(1107 + 500 - 100);
    expect(basket.vatTotal).toBe(basket.vatLines.reduce((s, l) => s + l.vat, 0));
  });

  it("safePriceCart drops a fixed discount that no longer fits instead of throwing", () => {
    const c = add(emptyCart, line({ unitPriceCents: 100, discount: { amount: 500 } }));
    expect(() => priceCart(c, ctx)).toThrow(RangeError);
    const r = safePriceCart(c, ctx, "card");
    expect(r.stripped).toBe(true);
    expect(r.priced.basket.total).toBe(100);
    expect(safePriceCart(emptyCart, ctx).stripped).toBe(false);
  });
});

describe("promptsFor (business-type behaviour)", () => {
  it("electronics asks for a serial only when the variant needs one", () => {
    const r = presets.electronics.register;
    expect(promptsFor({ serialRequired: true }, false, r, false)).toEqual(["serial"]);
    expect(promptsFor({ serialRequired: false }, false, r, false)).toEqual([]);
  });

  it("general asks for an age check once per sale", () => {
    const r = presets.general.register;
    expect(promptsFor({ ageRestricted: true }, false, r, false)).toEqual(["age"]);
    expect(promptsFor({ ageRestricted: true }, false, r, true)).toEqual([]);
  });

  it("cafe asks for modifiers when the product has groups; other types ignore stray attributes", () => {
    expect(promptsFor({}, true, presets.cafe.register, false)).toEqual(["modifiers"]);
    expect(promptsFor({ ageRestricted: true }, false, presets.cafe.register, false)).toEqual([]);
  });

  it("asks in order: modifiers, serial, age", () => {
    const all = { ...presets.general.register, serialPrompt: true };
    expect(promptsFor({ serialRequired: true, ageRestricted: true }, true, all, false)).toEqual([
      "modifiers",
      "serial",
      "age",
    ]);
  });
});
