import { describe, expect, it } from "vitest";
import {
  allergensOf,
  cartReducer,
  emptyCart,
  ORDER_NAME_MAX,
  type CartLine,
} from "@/lib/register/cart";
import { allergenListLines, buildTickets, wrapText } from "@/lib/register/ticket";

const line = (over: Partial<CartLine>): CartLine => ({
  id: "l",
  variantId: "v",
  productId: "p",
  name: "Latte",
  unitPriceCents: 400,
  modifiers: [],
  qty: 1,
  taxCategory: "CATERING",
  takeawayTaxCategory: "CATERING",
  depositCents: 0,
  ...over,
});

const labels = {
  order: "Order",
  eatIn: "EAT IN",
  takeAway: "TAKE AWAY",
  allergens: "ALLERGENS",
  allergen: (c: string) => c.toUpperCase(),
};

describe("buildTickets", () => {
  const lines = [
    line({
      id: "1",
      productId: "coffee",
      qty: 2,
      modifiers: [{ id: "m", name: "Oat milk", priceDeltaCents: 50 }],
    }),
    line({ id: "2", productId: "sandwich", name: "Ham sandwich", allergens: ["milk", "eggs"] }),
  ];
  const base = {
    number: "Till 1 · 000042",
    time: "14:32",
    colsOf: () => 32,
    stationOf: (l: CartLine) =>
      l.productId === "coffee" ? ("bar" as const) : ("kitchen" as const),
    labels,
  };

  it("makes one ticket per station, bar first, with modifiers, order name and mode", () => {
    const t = buildTickets({ ...base, cart: { lines, mode: "take_away", orderName: "Aoife" } });
    expect(t.map((x) => x.station)).toEqual(["bar", "kitchen"]);
    expect(t[0]!.lines).toContain("AOIFE");
    expect(t[0]!.lines).toContain("TAKE AWAY");
    expect(t[0]!.lines).toContain("2 x Latte");
    expect(t[0]!.lines).toContain("   + Oat milk");
    expect(t[0]!.lines.join("\n")).not.toContain("sandwich");
    expect(t[1]!.lines.join("\n")).toContain("ALLERGENS: MILK, EGGS");
  });

  it("skips a station with nothing to make and never prints a price", () => {
    const t = buildTickets({ ...base, cart: { lines: [lines[0]!] } });
    expect(t.map((x) => x.station)).toEqual(["bar"]);
    expect(t[0]!.lines).toContain("EAT IN");
    expect(t[0]!.lines.join("\n")).not.toMatch(/€|\d\.\d\d/);
  });

  it("never exceeds the paper width", () => {
    const long = line({
      name: "An extremely long drink name that must wrap onto lines",
      allergens: ["cereals_gluten", "sulphites"],
    });
    const t = buildTickets({
      ...base,
      colsOf: () => 32,
      cart: { lines: [long], orderName: "x".repeat(ORDER_NAME_MAX) },
    });
    for (const l of t[0]!.lines) expect(l.length).toBeLessThanOrEqual(32);
  });
});

describe("allergenListLines", () => {
  it("lists only items with allergens, sorted", () => {
    const out = allergenListLines(
      [
        { name: "Tea", allergens: [] },
        { name: "Scone", allergens: ["milk", "eggs"] },
        { name: "Cake", allergens: ["nuts"] },
      ],
      32,
      "Allergens",
      (c) => c,
    );
    expect(out.join("|")).toBe(
      "Allergens|--------------------------------|Cake|  nuts|Scone|  milk, eggs",
    );
  });
});

describe("wrapText", () => {
  it("splits an over-long word", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("cart order name and allergens", () => {
  it("sets, trims to the limit and clears the order name", () => {
    const c = cartReducer(emptyCart, { type: "orderName", name: "y".repeat(ORDER_NAME_MAX + 5) });
    expect(c.orderName).toHaveLength(ORDER_NAME_MAX);
    expect(cartReducer(c, { type: "orderName", name: "" }).orderName).toBeUndefined();
  });
  it("drops control characters from the order name", () => {
    const c = cartReducer(emptyCart, { type: "orderName", name: "\u0001Ann\u001b\n" });
    expect(c.orderName).toBe("Ann");
  });
  it("reads only string allergens from attributes", () => {
    expect(allergensOf({ allergens: ["milk", 3, null] })).toEqual(["milk"]);
    expect(allergensOf({})).toEqual([]);
  });
});
