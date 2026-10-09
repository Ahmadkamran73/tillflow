import { assertInt, cashRound, roundHalfUp } from "./vat";

/**
 * Refund maths. A refund never recalculates a sale: it takes a share of the stored sale-line
 * snapshot (gross, VAT, rate), so VAT is reversed at the ORIGINAL line rate, discounts included.
 */

export interface RefundLineInput {
  /** Quantity on the original sale line. */
  qty: number;
  /** The original line's stored gross and VAT (after discounts). */
  gross: number;
  vat: number;
  /** Units of this line already refunded by earlier refunds. */
  refundedQty: number;
  /** Units refunded now (1..qty - refundedQty). */
  refundQty: number;
}

export interface RefundLineAmounts {
  gross: number;
  vat: number;
  net: number;
}

/**
 * The share of one sale line given back for `refundQty` units. Cumulative and proportional: after
 * k units refunded in total the line has returned `roundHalfUp(total * k, qty)`, and a refund is the
 * difference between that and what earlier refunds returned. So the pieces of any sequence of
 * partial refunds add up EXACTLY to the original line, however it was split, and the last unit
 * takes the rounding remainder. Gross and VAT are done separately; net = gross - VAT.
 */
export function refundLine(input: RefundLineInput): RefundLineAmounts {
  const { qty, gross, vat, refundedQty, refundQty } = input;
  assertInt(qty, "qty");
  assertInt(gross, "gross");
  assertInt(vat, "vat");
  assertInt(refundedQty, "refundedQty");
  assertInt(refundQty, "refundQty");
  if (qty < 1) throw new RangeError("qty must be >= 1");
  if (gross < 0 || vat < 0 || vat > gross) throw new RangeError("line gross/vat out of range");
  if (refundedQty < 0 || refundQty < 1 || refundedQty + refundQty > qty) {
    throw new RangeError(`cannot refund ${refundQty} after ${refundedQty} of ${qty}`);
  }
  const share = (total: number, k: number) => roundHalfUp(assertInt(total * k, "line"), qty);
  const done = refundedQty;
  const upTo = done + refundQty;
  const g = share(gross, upTo) - share(gross, done);
  const v = share(vat, upTo) - share(vat, done);
  return { gross: g, vat: v, net: g - v };
}

/** Re-turn deposit (outside VAT) given back: the unit deposit times the units returned. */
export function refundDeposit(unitDeposit: number, refundQty: number): number {
  assertInt(unitDeposit, "unitDeposit");
  assertInt(refundQty, "refundQty");
  if (unitDeposit < 0 || refundQty < 1) throw new RangeError("deposit out of range");
  return unitDeposit * refundQty;
}

export interface RefundTotals {
  itemsTotal: number;
  vatTotal: number;
  nonVatTotal: number;
  /** Items plus non-VAT lines: the refund before any cash rounding. */
  total: number;
  vatByRate: { rateBp: number; gross: number; net: number; vat: number }[];
}

/** Totals of the refunded taxed lines (each with its original rate) and non-VAT deposit lines. */
export function refundTotals(
  lines: readonly { rateBp: number; gross: number; vat: number }[],
  nonVat: readonly number[] = [],
): RefundTotals {
  const byRate = new Map<number, { rateBp: number; gross: number; net: number; vat: number }>();
  let itemsTotal = 0;
  let vatTotal = 0;
  for (const l of lines) {
    assertInt(l.rateBp, "rateBp");
    assertInt(l.gross, "gross");
    assertInt(l.vat, "vat");
    itemsTotal += l.gross;
    vatTotal += l.vat;
    const r = byRate.get(l.rateBp) ?? { rateBp: l.rateBp, gross: 0, net: 0, vat: 0 };
    r.gross += l.gross;
    r.vat += l.vat;
    r.net += l.gross - l.vat;
    byRate.set(l.rateBp, r);
  }
  const nonVatTotal = nonVat.reduce((s, n) => s + assertInt(n, "nonVat"), 0);
  return {
    itemsTotal,
    vatTotal,
    nonVatTotal,
    total: itemsTotal + nonVatTotal,
    vatByRate: [...byRate.values()].sort((a, b) => a.rateBp - b.rateBp),
  };
}

export type RefundMethod = "cash" | "card";

/** One leg of the money going back. `amount` is what leaves the shop by that method. */
export interface RefundLeg {
  method: RefundMethod;
  amount: number;
  /** A card tip handed back; only on a void, outside the refund total. */
  tip?: number;
}

/** What each method paid on the original sale less what earlier refunds sent back by it. */
export type RefundAvailable = Record<RefundMethod, number>;

export type RefundError =
  | "bad_amount" // a non-positive leg or negative tip
  | "two_cash" // more than one cash leg
  | "over_method" // a leg above what that method paid
  | "tip_not_card" // a tip on cash
  | "over" // the card leg above what is to be paid out
  | "short"; // legs do not cover what is to be paid out

export interface RefundSettlement {
  /** Refund total less exchange credit: what actually goes back to the customer. */
  payout: number;
  /** 5c rounding on the cash leg only; 0 when no cash goes out. */
  rounding: number;
  /** Cash the till pays out (cash share plus rounding). */
  cashDue: number;
  /** Still to allocate (0 once settled). */
  balance: number;
  tips: number;
  ok: boolean;
  error?: RefundError;
}

/**
 * Cash rounding can push a cash leg up to 2c above what the original cash payment left. Every
 * earlier refund that paid cash was rounded on its own, so the drift adds up: callers pass 2c for
 * each refund so far and for this one (`cashSlack`).
 */
const CASH_SLACK = 2;

/**
 * Checks the legs a cashier chose for a refund. `total` is the refund (items + non-VAT) before
 * rounding; `credit` is exchange credit applied to the new sale, so only `total - credit` goes
 * back. The card leg is exact; the cash share (`payout - card`) alone is
 * rounded to 5c when `roundCash`, and the cash leg must equal it. Each method is capped at what
 * it paid (`available`), so a card sale can never be refunded in cash.
 */
export function settleRefund(
  total: number,
  legs: readonly RefundLeg[],
  available: RefundAvailable,
  {
    roundCash = true,
    credit = 0,
    cashSlack = CASH_SLACK,
  }: { roundCash?: boolean; credit?: number; cashSlack?: number } = {},
): RefundSettlement {
  assertInt(total, "total");
  assertInt(credit, "credit");
  if (total < 0 || credit < 0 || credit > total) throw new RangeError("credit out of range");
  const payout = total - credit;
  let nonCash = 0;
  let cashLeg = 0;
  let cashCount = 0;
  let tips = 0;
  let error: RefundError | undefined;
  const used: RefundAvailable = { cash: 0, card: 0 };
  for (const l of legs) {
    assertInt(l.amount, "amount");
    const tip = l.tip ?? 0;
    assertInt(tip, "tip");
    if (l.amount <= 0 || tip < 0) error ??= "bad_amount";
    if (tip > 0 && l.method !== "card") error ??= "tip_not_card";
    tips += tip;
    used[l.method] += l.amount;
    if (l.method === "cash") {
      cashCount++;
      cashLeg += l.amount;
    } else nonCash += l.amount;
  }
  if (cashCount > 1) error ??= "two_cash";
  for (const m of ["cash", "card"] as const) {
    const cap = available[m] + (m === "cash" && available.cash > 0 ? cashSlack : 0);
    if (used[m] > cap) error ??= "over_method";
  }
  if (nonCash > payout) error ??= "over";
  const cashShare = Math.max(payout - nonCash, 0);
  // A 1-2c remainder rounds to nothing, so it settles by itself even with no cash leg.
  const rounding =
    roundCash && cashShare > 0 && (cashCount > 0 || cashShare <= 2)
      ? cashRound(cashShare).adjustment
      : 0;
  const cashDue = cashShare + rounding;
  if (cashCount > 0 && cashShare === 0) error ??= "bad_amount";
  const paid = cashCount > 0 ? cashLeg : 0;
  const balance = Math.max(cashDue - paid, 0);
  if (!error && (balance > 0 || (cashCount > 0 && cashLeg !== cashDue))) error = "short";
  return {
    payout,
    rounding,
    cashDue,
    balance: error === "over" ? 0 : balance,
    tips,
    ok: !error,
    error,
  };
}

/**
 * The default allocation offered to the cashier: card first, cash last (rounded when
 * `roundCash`). The cashier may change it; `settleRefund` is what decides if it is valid.
 */
export function suggestRefundLegs(
  total: number,
  available: RefundAvailable,
  { roundCash = true, credit = 0 }: { roundCash?: boolean; credit?: number } = {},
): RefundLeg[] {
  assertInt(total, "total");
  assertInt(credit, "credit");
  let left = Math.max(total - credit, 0);
  const legs: RefundLeg[] = [];
  for (const m of ["card"] as const) {
    const amount = Math.min(left, Math.max(available[m], 0));
    if (amount > 0) {
      legs.push({ method: m, amount });
      left -= amount;
    }
  }
  if (left > 0) {
    const cash = roundCash ? left + cashRound(left).adjustment : left;
    if (cash > 0) legs.push({ method: "cash", amount: cash });
  }
  return legs;
}

/** A cashier's refund above the shop's limit needs a manager; managers at the till never do. */
export function refundNeedsOverride(
  total: number,
  limitCents: number,
  role: "cashier" | "manager" | "owner",
): boolean {
  assertInt(total, "total");
  assertInt(limitCents, "limitCents");
  return role === "cashier" && total > limitCents;
}
