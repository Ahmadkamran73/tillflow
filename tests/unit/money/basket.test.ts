import { describe, expect, it } from "vitest";
import {
  applyDiscount,
  calculateBasket,
  splitVat,
  type Basket,
  type BasketInput,
  type BasketLine,
  type TaxCategory,
} from "@/lib/money";
import { IRISH_RATES } from "./irish-rates";

const base = {
  country: "IE",
  date: "2026-07-01",
  mode: "eat_in",
  rates: IRISH_RATES,
  tender: "card",
} as const;
const basket = (lines: BasketLine[], extra: Partial<BasketInput> = {}) =>
  calculateBasket({ ...base, lines, ...extra });
const item = (unitPrice: number, taxCategory: TaxCategory = "STANDARD", qty = 1): BasketLine => ({
  kind: "item",
  unitPrice,
  qty,
  taxCategory,
});

describe("applyDiscount", () => {
  it.each([
    [597, { percentBp: 1000 }, 537], // 59.7c → 60c
    [5, { percentBp: 1000 }, 4], // 0.5c rounds half-up → 1c
    [-5, { percentBp: 1000 }, -4], // refund mirrors
    [597, { amount: 100 }, 497],
    [-597, { amount: 100 }, -497],
    [597, { amount: 597 }, 0],
    [597, { percentBp: 10000 }, 0],
    [597, { percentBp: 0 }, 597],
  ])("%i less %j = %i", (gross, discount, expected) =>
    expect(applyDiscount(gross, discount)).toBe(expected),
  );
  it.each([
    [100, { amount: 101 }],
    [100, { amount: -1 }],
    [100, { amount: 1.5 }],
    [100, { percentBp: 10001 }],
    [100, { percentBp: -1 }],
    [100, { percentBp: 0.5 }],
    [1.5, { amount: 0 }],
  ])("rejects %i less %j", (gross, discount) =>
    expect(() => applyDiscount(gross, discount)).toThrow(RangeError),
  );
});

describe("calculateBasket", () => {
  it("returns zeros for an empty basket", () =>
    expect(basket([])).toEqual({
      vatLines: [],
      nonVatLines: [],
      vatByRate: [],
      itemsTotal: 0,
      serviceChargeTotal: 0,
      serviceChargeBase: 0,
      vatTotal: 0,
      nonVatTotal: 0,
      total: 0,
      cashRounding: 0,
      amountDue: 0,
    }));

  it("splits VAT per line and groups it by rate", () => {
    const b = basket([item(123), item(1000, "CATERING", 2), item(250, "ZERO"), item(123)]);
    expect(b.vatLines).toEqual([
      {
        index: 0,
        component: null,
        mode: "eat_in",
        taxCategory: "STANDARD",
        rateBp: 2300,
        gross: 123,
        net: 100,
        vat: 23,
      },
      {
        index: 1,
        component: null,
        mode: "eat_in",
        taxCategory: "CATERING",
        rateBp: 900,
        gross: 2000,
        net: 1835,
        vat: 165,
      },
      {
        index: 2,
        component: null,
        mode: "eat_in",
        taxCategory: "ZERO",
        rateBp: 0,
        gross: 250,
        net: 250,
        vat: 0,
      },
      {
        index: 3,
        component: null,
        mode: "eat_in",
        taxCategory: "STANDARD",
        rateBp: 2300,
        gross: 123,
        net: 100,
        vat: 23,
      },
    ]);
    expect(b.vatByRate).toEqual([
      { rateBp: 2300, gross: 246, net: 200, vat: 46 },
      { rateBp: 900, gross: 2000, net: 1835, vat: 165 },
      { rateBp: 0, gross: 250, net: 250, vat: 0 },
    ]);
    expect(b).toMatchObject({ itemsTotal: 2496, vatTotal: 211, total: 2496, amountDue: 2496 });
  });

  it("uses the rate in force on the sale date (catering 30 June vs 1 July 2026)", () => {
    const lines = [item(1000, "CATERING")];
    expect(basket(lines, { date: "2026-06-30" }).vatLines[0]).toMatchObject({
      rateBp: 1350,
      vat: 119,
    });
    expect(basket(lines, { date: "2026-07-01" }).vatLines[0]).toMatchObject({
      rateBp: 900,
      vat: 83,
    });
  });

  it("switches category for take-away", () => {
    const lines: BasketLine[] = [
      {
        kind: "item",
        unitPrice: 600,
        qty: 1,
        taxCategory: "CATERING",
        takeawayTaxCategory: "ZERO",
      },
    ];
    expect(basket(lines).vatLines[0]).toMatchObject({ taxCategory: "CATERING", vat: 50 });
    expect(basket(lines, { mode: "take_away" }).vatLines[0]).toMatchObject({
      taxCategory: "ZERO",
      vat: 0,
    });
  });

  it("lets a line override the basket mode and records the mode used", () => {
    const sandwich = { taxCategory: "CATERING", takeawayTaxCategory: "ZERO" } as const;
    const b = basket([
      { kind: "item", unitPrice: 350, qty: 1, taxCategory: "CATERING" }, // coffee, drunk in
      { kind: "item", unitPrice: 600, qty: 1, mode: "take_away", ...sandwich },
      {
        kind: "deal",
        price: 800,
        qty: 1,
        mode: "take_away",
        components: [{ standalonePrice: 800, ...sandwich }],
      },
    ]);
    expect(b.vatLines.map((l) => [l.mode, l.taxCategory])).toEqual([
      ["eat_in", "CATERING"],
      ["take_away", "ZERO"],
      ["take_away", "ZERO"],
    ]);
  });

  it("apportions a meal deal across rates by standalone price", () => {
    const b = basket([
      {
        kind: "deal",
        price: 1000,
        qty: 1,
        components: [
          { standalonePrice: 450, taxCategory: "CATERING" },
          { standalonePrice: 350, taxCategory: "STANDARD" },
          { standalonePrice: 250, taxCategory: "ZERO" },
        ],
      },
    ]);
    expect(b.vatLines.map((l) => [l.component, l.gross, l.rateBp, l.vat])).toEqual([
      [0, 429, 900, splitVat(429, 900).vat],
      [1, 333, 2300, splitVat(333, 2300).vat],
      [2, 238, 0, 0],
    ]);
    expect(b.total).toBe(1000);
  });

  it("discounts and multiplies a deal before apportioning, honouring take-away", () => {
    const b = basket(
      [
        {
          kind: "deal",
          price: 800,
          qty: 2,
          discount: { amount: 100 },
          components: [
            { standalonePrice: 500, taxCategory: "CATERING", takeawayTaxCategory: "ZERO" },
            { standalonePrice: 300, taxCategory: "STANDARD" },
          ],
        },
      ],
      { mode: "take_away" },
    );
    expect(b.vatLines.map((l) => [l.taxCategory, l.gross])).toEqual([
      ["ZERO", 938], // 1500 × 5/8 = 937.5
      ["STANDARD", 562],
    ]);
  });

  it("applies a line discount before VAT", () => {
    const b = basket([
      { ...item(199, "STANDARD", 3), discount: { percentBp: 1000 } } as BasketLine,
    ]);
    expect(b.vatLines[0]).toMatchObject({ gross: 537, ...splitVat(537, 2300) });
  });

  it("apportions a basket discount over taxed lines only", () => {
    const b = basket([item(600), item(400, "ZERO"), { kind: "deposit", unitPrice: 15, qty: 2 }], {
      basketDiscount: { amount: 100 },
    });
    expect(b.vatLines.map((l) => l.gross)).toEqual([540, 360]);
    expect(b.nonVatLines).toEqual([{ index: 2, kind: "deposit", gross: 30 }]);
    expect(b.total).toBe(930);
  });

  it("keeps the Re-turn deposit and bag levy out of VAT", () => {
    const b = basket([
      item(250),
      { kind: "deposit", unitPrice: 15, qty: 1 },
      { kind: "deposit", unitPrice: 25, qty: 2 },
      { kind: "levy", unitPrice: 22, qty: 1 },
    ]);
    expect(b.nonVatLines.map((l) => [l.kind, l.gross])).toEqual([
      ["deposit", 15],
      ["deposit", 50],
      ["levy", 22],
    ]);
    expect(b).toMatchObject({
      itemsTotal: 250,
      nonVatTotal: 87,
      total: 337,
      vatTotal: splitVat(250, 2300).vat,
    });
  });

  it.each([
    ["cash", 1002, -2, 1000],
    ["cash", 1003, 2, 1005],
    ["cash", 1008, 2, 1010],
    ["card", 1003, 0, 1003],
  ] as const)("%s tender on %i rounds by %i to %i", (tender, price, cashRounding, amountDue) =>
    expect(basket([item(price)], { tender })).toMatchObject({
      total: price,
      cashRounding,
      amountDue,
    }),
  );

  it("mirrors a sale as a refund", () => {
    const sale = basket([item(1002, "CATERING")], { tender: "cash" });
    const refund = basket([item(1002, "CATERING", -1)], { tender: "cash" });
    expect(refund.vatLines[0]).toMatchObject({
      gross: -1002,
      net: -sale.vatLines[0]!.net,
      vat: -sale.vatLines[0]!.vat,
    });
    expect(refund).toMatchObject({ cashRounding: 2, amountDue: -1000 });
  });

  it("rejects a basket discount over mixed sales and refunds", () =>
    expect(() =>
      basket([item(100), item(100, "STANDARD", -1)], { basketDiscount: { amount: 1 } }),
    ).toThrow(/mixing/));
  it("rejects a basket discount larger than the basket", () =>
    expect(() => basket([item(100)], { basketDiscount: { amount: 101 } })).toThrow(RangeError));
  it("rejects a missing rate", () =>
    expect(() => basket([item(100)], { date: "2020-01-01" })).toThrow(/0 IE STANDARD/));
  it.each([
    [{ kind: "item", unitPrice: 1.5, qty: 1, taxCategory: "STANDARD" }],
    [{ kind: "item", unitPrice: 100, qty: 0.5, taxCategory: "STANDARD" }],
    [{ kind: "levy", unitPrice: 2 ** 40, qty: 2 ** 20 }],
  ] as BasketLine[][])("rejects non-integer or overflowing line %j", (line) =>
    expect(() => basket([line])).toThrow(RangeError),
  );
});

/** Seeded PRNG (mulberry32) so the property run is repeatable. */
function rng(seed: number) {
  return (max: number) => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) % max) | 0;
  };
}

const CATS: TaxCategory[] = [
  "STANDARD",
  "REDUCED",
  "SECOND_REDUCED",
  "ZERO",
  "LIVESTOCK",
  "CATERING",
  "HAIRDRESSING",
];

function randomBasket(r: (max: number) => number): BasketInput {
  const cat = () => CATS[r(CATS.length)]!;
  // a CATERING product must say what it becomes on take-away
  const taxed = (c = cat()) => ({
    taxCategory: c,
    takeawayTaxCategory: c === "CATERING" || r(2) ? cat() : undefined,
  });
  const discount = () => (r(3) === 0 ? { percentBp: r(10001) } : undefined);
  const lines: BasketLine[] = Array.from({ length: r(8) }, (): BasketLine => {
    const qty = 1 + r(5);
    switch (r(4)) {
      case 0:
        return {
          kind: "deal",
          price: r(3000),
          qty,
          discount: discount(),
          components: [
            { standalonePrice: 1 + r(900), ...taxed() },
            { standalonePrice: r(900), ...taxed() },
          ],
        };
      case 1:
        return { kind: r(2) ? "deposit" : "levy", unitPrice: r(50), qty };
      default:
        return {
          kind: "item",
          unitPrice: r(5000),
          qty,
          ...taxed(),
          discount: discount(),
        };
    }
  });
  return {
    ...base,
    date: r(2) ? "2026-06-30" : "2026-07-01",
    mode: r(2) ? "eat_in" : "take_away",
    tender: r(2) ? "cash" : "card",
    basketDiscount: r(2) ? { percentBp: r(5001) } : undefined,
    lines,
  };
}

const negate = (input: BasketInput): BasketInput => ({
  ...input,
  lines: input.lines.map((l) => ({ ...l, qty: -l.qty })),
});

function checkReconciles(b: Basket) {
  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  expect(sum(b.vatLines.map((l) => l.gross))).toBe(b.itemsTotal);
  expect(sum(b.vatLines.map((l) => l.vat))).toBe(b.vatTotal);
  expect(sum(b.nonVatLines.map((l) => l.gross))).toBe(b.nonVatTotal);
  expect(b.itemsTotal + b.nonVatTotal).toBe(b.total);
  expect(b.total + b.cashRounding).toBe(b.amountDue);
  expect(sum(b.vatByRate.map((r) => r.gross))).toBe(b.itemsTotal);
  expect(sum(b.vatByRate.map((r) => r.vat))).toBe(b.vatTotal);
  for (const l of b.vatLines) {
    expect(l.net + l.vat).toBe(l.gross);
    // independent BigInt reference for the per-line VAT split
    const num = BigInt(Math.abs(l.gross)) * BigInt(10000);
    const den = BigInt(10000 + l.rateBp);
    const net = Number((BigInt(2) * num + den) / (BigInt(2) * den)); // floor(x + 1/2)
    expect(Math.abs(l.net)).toBe(net);
  }
  if (b.amountDue !== b.total) expect(Math.abs(b.amountDue) % 5).toBe(0);
}

describe("property: 1,000 random baskets", () => {
  it("reconcile and mirror as refunds", () => {
    const r = rng(20261003);
    for (let i = 0; i < 1000; i++) {
      const input = randomBasket(r);
      const sale = calculateBasket(input);
      checkReconciles(sale);
      const refund = calculateBasket(negate(input));
      checkReconciles(refund);
      expect(refund.amountDue).toBe(-sale.amountDue || 0);
      expect(refund.vatLines.map((l) => [l.gross, l.vat])).toEqual(
        sale.vatLines.map((l) => [-l.gross || 0, -l.vat || 0]),
      );
    }
  });
});

describe("service charge in the basket", () => {
  const lines = [item(3000, "CATERING"), item(1000, "STANDARD"), item(500, "CATERING", 2)];
  it("adds one line per charged item, at that item's own rate, tied to it", () => {
    const b = basket(lines, { serviceChargeBp: 1250 });
    const extra = b.vatLines.filter((l) => l.index >= lines.length);
    expect(extra.map((l) => l.rateBp)).toEqual([900, 2300, 900]);
    expect(extra.map((l) => l.index)).toEqual([3, 4, 5]);
    expect(extra.map((l) => l.serviceFor)).toEqual([0, 1, 2]);
    expect(extra.map((l) => l.gross)).toEqual([375, 125, 125]);
    expect(b.serviceChargeTotal).toBe(625); // 12.5% of 5000
    expect(b.itemsTotal).toBe(5625);
    expect(b.total).toBe(5625);
    for (const l of extra) expect(l.net + l.vat).toBe(l.gross);
  });
  it("is charged after discounts and never on take-away or refunds", () => {
    expect(
      basket(lines, { serviceChargeBp: 1000, basketDiscount: { amount: 500 } }).serviceChargeTotal,
    ).toBe(450);
    expect(
      basket([item(1000)], { serviceChargeBp: 1000, mode: "take_away" }).serviceChargeTotal,
    ).toBe(0);
    expect(basket([item(-1000)], { serviceChargeBp: 1000 }).serviceChargeTotal).toBe(0);
  });
  it("does nothing at 0 or when it rounds to nothing", () => {
    expect(basket(lines).serviceChargeTotal).toBe(0);
    expect(basket([item(0)], { serviceChargeBp: 1000 }).vatLines).toHaveLength(1);
    expect(basket([item(1, "ZERO")], { serviceChargeBp: 100 }).vatLines).toHaveLength(1);
  });
});

describe("a fixed service charge in the basket", () => {
  const lines = [item(3000, "CATERING"), item(1000, "STANDARD")];
  it("is shared over the eat-in lines by their gross, grouped by rate, and replaces the percentage", () => {
    const b = basket(lines, { serviceChargeBp: 1250, serviceChargeCents: 101 });
    expect(b.serviceChargeTotal).toBe(101);
    expect(b.serviceChargeBase).toBe(4000);
    expect(b.vatLines.filter((l) => l.index >= lines.length).map((l) => l.gross)).toEqual([76, 25]);
    for (const l of b.vatLines) expect(l.net + l.vat).toBe(l.gross);
  });
  it("a fixed charge of 0 means none, even with a percentage", () => {
    const b = basket(lines, { serviceChargeBp: 1250, serviceChargeCents: 0 });
    expect(b.serviceChargeTotal).toBe(0);
    expect(b.vatLines).toHaveLength(2);
  });
  it("charges nothing, and never throws, when there is nothing eat-in to charge on", () => {
    const b = basket([item(1000)], { serviceChargeCents: 10, mode: "take_away" });
    expect(b.serviceChargeTotal).toBe(0);
    expect(b.serviceChargeBase).toBe(0);
  });
  it("the base is 0 without a charge", () => {
    expect(basket(lines).serviceChargeBase).toBe(0);
  });
});
