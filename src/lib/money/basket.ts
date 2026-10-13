import { categoryFor, findRateBp, type RateRow, type ServiceMode, type TaxCategory } from "./rates";
import { serviceChargeShares } from "./service";
import { apportion, assertInt, cashRound, roundHalfUp, splitVat } from "./vat";

/** A fixed amount in cents or a percentage in basis points (1000 = 10%). */
export type Discount = { amount: number } | { percentBp: number };

type Taxed = { taxCategory: TaxCategory; takeawayTaxCategory?: TaxCategory };

/**
 * VAT-inclusive prices in cents; negative `qty` is a refund. `mode` overrides the basket's
 * eat-in/take-away mode for one line (coffee to drink in, sandwich to go).
 */
export type BasketLine =
  | (Taxed & {
      kind: "item";
      unitPrice: number;
      qty: number;
      discount?: Discount;
      mode?: ServiceMode;
    })
  | {
      kind: "deal";
      price: number;
      qty: number;
      discount?: Discount;
      mode?: ServiceMode;
      components: (Taxed & { standalonePrice: number })[];
    }
  | { kind: "deposit"; unitPrice: number; qty: number }
  | { kind: "levy"; unitPrice: number; qty: number };

export type Tender = "cash" | "card";

export interface BasketInput {
  country: string;
  /** Shop-local sale date, `YYYY-MM-DD` (see `localDate`). */
  date: string;
  mode: ServiceMode;
  rates: readonly RateRow[];
  tender: Tender;
  basketDiscount?: Discount;
  /**
   * Restaurant service charge in basis points of the eat-in food and drink AFTER discounts (never
   * on take-away, deposits or levies). Added as one extra taxed line per charged item line, with
   * index `lines.length + n`, each taxed at the rate of the item it was charged on.
   */
  serviceChargeBp?: number;
  /**
   * A fixed service charge in cents, used instead of the percentage: a part of a split bill carries
   * its whole-cent share of the whole bill's charge, so the parts add up to it exactly.
   */
  serviceChargeCents?: number;
  lines: readonly BasketLine[];
}

/** One taxed line; `component` is the meal-deal component index, else null. Snapshot these. */
export interface VatLine {
  index: number;
  component: number | null;
  mode: ServiceMode;
  taxCategory: TaxCategory;
  rateBp: number;
  gross: number;
  net: number;
  vat: number;
  /** A service-charge line: the index of the item line it was charged on (so a refund can pair them). */
  serviceFor?: number;
}

export interface Basket {
  vatLines: VatLine[];
  nonVatLines: { index: number; kind: "deposit" | "levy"; gross: number }[];
  vatByRate: { rateBp: number; gross: number; net: number; vat: number }[];
  itemsTotal: number;
  /** The service charge inside `itemsTotal` (its lines have index >= the number of input lines). */
  serviceChargeTotal: number;
  /** The eat-in food and drink gross the service charge was worked out on (0 when none). */
  serviceChargeBase: number;
  vatTotal: number;
  nonVatTotal: number;
  total: number;
  /** 5c cash rounding, its own receipt line; 0 unless the tender is cash. */
  cashRounding: number;
  amountDue: number;
}

/** `base` reduced toward zero by the discount, so a refund mirrors the sale. */
export function applyDiscount(base: number, discount: Discount): number {
  const mag = Math.abs(assertInt(base, "base"));
  let amount: number;
  if ("amount" in discount) {
    amount = assertInt(discount.amount, "discount");
  } else {
    const bp = assertInt(discount.percentBp, "percentBp");
    if (bp < 0 || bp > 10000) throw new RangeError(`percentBp must be 0..10000, got ${bp}`);
    amount = roundHalfUp(mag * bp, 10000);
  }
  if (amount < 0 || amount > mag) throw new RangeError(`discount ${amount} outside 0..${mag}`);
  return base < 0 ? base + amount : base - amount;
}

/** What a line lost to line and basket discounts: its full price less what it came to. */
export const lineDiscountOf = (unitPrice: number, qty: number, gross: number) =>
  lineGross(unitPrice, qty) - assertInt(gross, "gross");

/**
 * Half-up rounding of a percentage discount, and largest-remainder sharing of a basket discount,
 * can leave a line up to 2 cents over its exact share. The override rule allows for that.
 */
export const DISCOUNT_ROUNDING_SLACK_CENTS = 2;

/**
 * The manager-override rule for one price: is `discount` cents off `full` cents more than
 * `thresholdBp` (basis points) of `full`? Exact integer maths (BigInt, no division, no floats):
 * (discount - slack) * 10000 > thresholdBp * full. A discount of at most the slack never counts,
 * and an exact threshold (say 10% of €10.00 = 100c) is not "above" it.
 */
export function discountExceedsThreshold(
  full: number,
  discount: number,
  thresholdBp: number,
): boolean {
  assertInt(full, "full");
  assertInt(discount, "discount");
  assertInt(thresholdBp, "thresholdBp");
  if (thresholdBp < 0 || thresholdBp > 10000) {
    throw new RangeError(`thresholdBp must be 0..10000, got ${thresholdBp}`);
  }
  if (full <= 0 || discount <= DISCOUNT_ROUNDING_SLACK_CENTS) return false;
  return (
    BigInt(discount - DISCOUNT_ROUNDING_SLACK_CENTS) * BigInt(10_000) >
    BigInt(thresholdBp) * BigInt(full)
  );
}

/**
 * Does this sale need a manager's approval? True when any item line, or the sale as a whole, lost
 * more than `thresholdBp` of its full price to line and basket discounts together. `gross` is what
 * the line came to after discounts (the basket's own figure), `unitPrice` includes modifiers.
 */
export function discountNeedsOverride(
  lines: readonly { unitPrice: number; qty: number; gross: number }[],
  thresholdBp: number,
): boolean {
  let full = 0;
  let discount = 0;
  for (const l of lines) {
    const lineFull = lineGross(l.unitPrice, l.qty);
    const lineLost = lineDiscountOf(l.unitPrice, l.qty, l.gross);
    if (discountExceedsThreshold(lineFull, lineLost, thresholdBp)) return true;
    full += lineFull;
    discount += lineLost;
  }
  return discountExceedsThreshold(full, discount, thresholdBp);
}

const lineGross = (unitPrice: number, qty: number) =>
  assertInt(assertInt(unitPrice, "unitPrice") * assertInt(qty, "qty"), "line gross");

export function calculateBasket(input: BasketInput): Basket {
  const { country, date, rates } = input;
  const taxed: Omit<VatLine, "rateBp" | "net" | "vat">[] = [];
  const nonVatLines: Basket["nonVatLines"] = [];

  input.lines.forEach((line, index) => {
    if (line.kind === "deposit" || line.kind === "levy") {
      nonVatLines.push({ index, kind: line.kind, gross: lineGross(line.unitPrice, line.qty) });
      return;
    }
    const mode = line.mode ?? input.mode;
    if (line.kind === "item") {
      const base = lineGross(line.unitPrice, line.qty);
      const gross = line.discount ? applyDiscount(base, line.discount) : base;
      taxed.push({ index, component: null, mode, taxCategory: categoryFor(line, mode), gross });
      return;
    }
    const base = lineGross(line.price, line.qty);
    const gross = line.discount ? applyDiscount(base, line.discount) : base;
    const parts = apportion(
      gross,
      line.components.map((c) => c.standalonePrice),
    );
    line.components.forEach((c, component) =>
      taxed.push({
        index,
        component,
        mode,
        taxCategory: categoryFor(c, mode),
        gross: parts[component]!,
      }),
    );
  });

  if (input.basketDiscount) {
    if (taxed.some((t) => t.gross > 0) && taxed.some((t) => t.gross < 0)) {
      throw new RangeError("basket discount on a basket mixing sales and refunds");
    }
    const sum = taxed.reduce((s, t) => s + t.gross, 0);
    const shares = apportion(
      sum - applyDiscount(sum, input.basketDiscount),
      taxed.map((t) => Math.abs(t.gross)),
    );
    taxed.forEach((t, i) => (t.gross -= shares[i]!)); // apportion returns one share per weight
  }

  const vatLines = taxed.map((t): VatLine => {
    const rateBp = findRateBp(rates, country, t.taxCategory, date);
    return { ...t, rateBp, ...splitVat(t.gross, rateBp) };
  });

  let serviceChargeBase = 0;
  if (input.serviceChargeBp || input.serviceChargeCents) {
    const served = vatLines.filter((l) => l.mode === "eat_in" && l.gross > 0);
    serviceChargeBase = served.reduce((s, l) => s + l.gross, 0);
    // Nothing eat-in to charge on: no charge (never a throw, which a sync queue would retry forever).
    const shares =
      serviceChargeBase === 0
        ? []
        : input.serviceChargeCents !== undefined
          ? apportion(
              assertInt(input.serviceChargeCents, "serviceChargeCents"),
              served.map((l) => l.gross),
            )
          : serviceChargeShares(served, input.serviceChargeBp!);
    // One service line per charged item line, taxed at that line's own rate and kept beside it, so a
    // refund of some of the item's units gives back the same share of its charge.
    let next = input.lines.length;
    served.forEach((l, i) => {
      const gross = shares[i]!;
      if (gross === 0) return;
      vatLines.push({
        index: next++,
        component: null,
        mode: "eat_in",
        taxCategory: l.taxCategory,
        rateBp: l.rateBp,
        gross,
        ...splitVat(gross, l.rateBp),
        serviceFor: l.index,
      });
    });
  }

  const byRate = new Map<number, Basket["vatByRate"][number]>();
  for (const l of vatLines) {
    const r = byRate.get(l.rateBp) ?? { rateBp: l.rateBp, gross: 0, net: 0, vat: 0 };
    r.gross += l.gross;
    r.net += l.net;
    r.vat += l.vat;
    byRate.set(l.rateBp, r);
  }

  const sum = (xs: { gross: number }[]) => xs.reduce((s, x) => s + x.gross, 0);
  const serviceChargeTotal = sum(vatLines.filter((l) => l.index >= input.lines.length));
  const itemsTotal = sum(vatLines);
  const nonVatTotal = sum(nonVatLines);
  const total = itemsTotal + nonVatTotal;
  const cashRounding = input.tender === "cash" ? cashRound(total).adjustment : 0;
  return {
    vatLines,
    nonVatLines,
    vatByRate: [...byRate.values()].sort((a, b) => b.rateBp - a.rateBp),
    itemsTotal,
    serviceChargeTotal,
    serviceChargeBase,
    vatTotal: vatLines.reduce((s, l) => s + l.vat, 0),
    nonVatTotal,
    total,
    cashRounding,
    amountDue: total + cashRounding,
  };
}
