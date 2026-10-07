import {
  calculateBasket,
  type Basket,
  type BasketInput,
  type Discount,
  type RateRow,
  type ServiceMode,
  type TaxCategory,
} from "@/lib/money";
import type { Preset } from "@/config/business-type-presets";

export type LineModifier = { id: string; name: string; priceDeltaCents: number };

export type CartLine = {
  id: string;
  variantId: string;
  productId: string;
  name: string;
  /** The variant's VAT-inclusive price; modifier deltas are added on top. */
  unitPriceCents: number;
  modifiers: LineModifier[];
  qty: number;
  taxCategory: TaxCategory;
  takeawayTaxCategory: TaxCategory | null;
  /** Re-turn deposit per unit, rung up as its own non-VAT line. */
  depositCents: number;
  serial?: string;
  /** Electronics: months of warranty, for the end date on the receipt. */
  warrantyMonths?: number;
  discount?: Discount;
};

export type Cart = {
  lines: CartLine[];
  discount?: Discount;
  ageChecked: boolean;
  /** Cafes and restaurants: eat-in (default) or take-away, which can change the VAT rate. */
  mode?: ServiceMode;
};

export const emptyCart: Cart = { lines: [], ageChecked: false };

export type CartAction =
  | { type: "add"; line: CartLine }
  | { type: "qty"; id: string; delta: 1 | -1 }
  | { type: "remove"; id: string }
  | { type: "lineDiscount"; id: string; discount: Discount | undefined }
  | { type: "basketDiscount"; discount: Discount | undefined }
  | { type: "ageChecked" }
  | { type: "mode"; mode: ServiceMode }
  | { type: "stripAmountDiscounts" }
  | { type: "load"; cart: Cart };

const MAX_QTY = 999;

/** A plain line (no modifiers, serial or discount) of the same variant just gains a unit. */
const mergeable = (l: CartLine) => !l.modifiers.length && !l.serial && !l.discount;

export function cartReducer(cart: Cart, a: CartAction): Cart {
  switch (a.type) {
    case "add": {
      const same = mergeable(a.line)
        ? cart.lines.find((l) => l.variantId === a.line.variantId && mergeable(l))
        : undefined;
      if (same) return cartReducer(cart, { type: "qty", id: same.id, delta: 1 });
      return { ...cart, lines: [...cart.lines, a.line] };
    }
    case "qty":
      return {
        ...cart,
        lines: cart.lines.flatMap((l) => {
          if (l.id !== a.id) return [l];
          const qty = l.qty + a.delta;
          if (qty < 1) return [];
          // A fixed discount was sized for the old quantity; the customer re-agrees it.
          return [
            {
              ...l,
              qty: Math.min(qty, MAX_QTY),
              discount: l.discount && "amount" in l.discount ? undefined : l.discount,
            },
          ];
        }),
      };
    case "remove":
      return { ...cart, lines: cart.lines.filter((l) => l.id !== a.id) };
    case "lineDiscount":
      return {
        ...cart,
        lines: cart.lines.map((l) => (l.id === a.id ? { ...l, discount: a.discount } : l)),
      };
    case "basketDiscount":
      return { ...cart, discount: a.discount };
    case "mode":
      return { ...cart, mode: a.mode };
    case "ageChecked":
      return { ...cart, ageChecked: true };
    case "stripAmountDiscounts": {
      const keep = (d: Discount | undefined) => (d && "percentBp" in d ? d : undefined);
      return {
        ...cart,
        discount: keep(cart.discount),
        lines: cart.lines.map((l) => ({ ...l, discount: keep(l.discount) })),
      };
    }
    case "load":
      return a.cart;
  }
}

/** Unit price including the chosen modifiers. */
export const unitWithModifiers = (l: Pick<CartLine, "unitPriceCents" | "modifiers">) =>
  l.unitPriceCents + l.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0);

export type BasketContext = { country: string; date: string; rates: readonly RateRow[] };

export type PricedCart = {
  basket: Basket;
  /** Per cart line: its index in the basket, to look up its (discounted) total. */
  itemIndex: number[];
};

/**
 * Hands the cart to the money library (the only place VAT and totals are worked out). A modifier
 * takes the VAT category of the product it is on. Display only: the server recalculates on sync.
 */
export function priceCart(
  cart: Cart,
  ctx: BasketContext,
  tender: "cash" | "card" = "card",
): PricedCart {
  const lines: BasketInput["lines"][number][] = [];
  const itemIndex = cart.lines.map((l) => {
    lines.push({
      kind: "item",
      unitPrice: unitWithModifiers(l),
      qty: l.qty,
      taxCategory: l.taxCategory,
      takeawayTaxCategory: l.takeawayTaxCategory ?? undefined,
      discount: l.discount,
    });
    const at = lines.length - 1;
    if (l.depositCents > 0) lines.push({ kind: "deposit", unitPrice: l.depositCents, qty: l.qty });
    return at;
  });
  const basket = calculateBasket({
    ...ctx,
    mode: cart.mode ?? "eat_in",
    tender,
    basketDiscount: cart.discount,
    lines,
  });
  return { basket, itemIndex };
}

/** What one cart line comes to after discounts. */
export const lineTotal = ({ basket }: PricedCart, index: number) =>
  basket.vatLines.filter((v) => v.index === index).reduce((s, v) => s + v.gross, 0);

/**
 * `priceCart`, but a fixed discount that no longer fits (the quantity dropped, an item was
 * removed) is dropped instead of crashing the screen. `stripped` tells the caller to say so.
 */
export function safePriceCart(cart: Cart, ctx: BasketContext, tender: "cash" | "card" = "card") {
  try {
    return { priced: priceCart(cart, ctx, tender), stripped: false };
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    const clean = cartReducer(cart, { type: "stripAmountDiscounts" });
    return { priced: priceCart(clean, ctx, tender), stripped: true };
  }
}

export type Prompt = "modifiers" | "serial" | "age";

/** Which questions the cashier must answer before this variant goes in the cart, in order. */
export function promptsFor(
  attributes: Record<string, unknown>,
  hasModifierGroups: boolean,
  register: Preset["register"],
  ageChecked: boolean,
): Prompt[] {
  const out: Prompt[] = [];
  if (hasModifierGroups) out.push("modifiers");
  if (register.serialPrompt && attributes.serialRequired === true) out.push("serial");
  if (register.ageCheck && attributes.ageRestricted === true && !ageChecked) out.push("age");
  return out;
}

/** The deposit per unit stored on a general-store variant, 0 for every other type. */
export const depositOf = (attributes: Record<string, unknown>) =>
  typeof attributes.depositCents === "number" && Number.isInteger(attributes.depositCents)
    ? Math.max(0, attributes.depositCents)
    : 0;

/** Warranty months stored on an electronics variant, 0 for every other type. */
export const warrantyOf = (attributes: Record<string, unknown>) =>
  typeof attributes.warrantyMonths === "number" && Number.isInteger(attributes.warrantyMonths)
    ? Math.max(0, attributes.warrantyMonths)
    : 0;

/** The variant's own name, or "size / colour" for a clothing matrix row. */
export const variantLabel = (v: { name: string; attributes: Record<string, unknown> }) =>
  v.name ||
  [v.attributes.size, v.attributes.colour].filter((s) => typeof s === "string").join(" / ");
