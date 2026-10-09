import { assertInt, cashRound } from "./vat";

export type TenderMethod = "cash" | "card";

/**
 * One payment on a sale. `amount` is what it settles (cash: the amount handed over, which may
 * exceed the share it settles; card: exactly what it settles). `tip` is a card tip,
 * kept apart from the sale total.
 */
export interface TenderLine {
  /** `exchange` is credit from goods returned in an exchange: exact, like a card. */
  method: TenderMethod | "exchange";
  amount: number;
  tip?: number;
}

export type TenderError =
  | "bad_amount" // a non-positive amount, or a tip that is negative
  | "two_cash" // more than one cash tender
  | "tip_not_card" // a tip on cash or exchange credit
  | "tip_too_big" // a tip above the card amount
  | "non_cash_over" // card + exchange credit above the total (no change from them)
  | "short"; // not enough to cover the amount due

export interface Settlement {
  /** Card + exchange credit amounts. */
  nonCash: number;
  /** The part of the total cash has to settle (total - nonCash, floored at 0). */
  cashShare: number;
  /** 5c rounding on the cash share only; 0 when no cash is due. */
  rounding: number;
  /** total + rounding: what the shop is paid for the sale. */
  amountDue: number;
  cashTendered: number;
  /** Change, only ever from cash. */
  change: number;
  /** Still to be paid before the sale can complete (0 when settled). */
  balance: number;
  tips: number;
  ok: boolean;
  error?: TenderError;
}

/**
 * Settles a sale total (VAT-inclusive, before cash rounding) against its tenders.
 *
 * - Card and exchange-credit tenders settle their exact amount; their sum may not exceed the total, so
 *   change can only ever come from cash. At most one cash tender; tips only on card, up to the
 *   card amount, and never part of the total.
 * - The 5c rounding (switched by `roundCash`, which follows the shop's preset) applies to the cash share only (`total - card - credit`), so it does not
 *   depend on the order tenders were taken, and an all-card sale is never rounded.
 * - `ok` is true when every rule holds and the tenders cover `amountDue`. While a split is still
 *   being built, `balance` says how much remains (the cash share plus rounding, less what has
 *   been handed over).
 */
export function settleTenders(
  total: number,
  tenders: readonly TenderLine[],
  { roundCash = true }: { roundCash?: boolean } = {},
): Settlement {
  assertInt(total, "total");
  let nonCash = 0;
  let cashTendered = 0;
  let cashCount = 0;
  let tips = 0;
  let error: TenderError | undefined;
  for (const t of tenders) {
    assertInt(t.amount, "amount");
    const tip = t.tip ?? 0;
    assertInt(tip, "tip");
    if (t.amount <= 0 || tip < 0) error ??= "bad_amount";
    if (tip > 0 && t.method !== "card") error ??= "tip_not_card";
    if (tip > t.amount) error ??= "tip_too_big";
    tips += tip;
    if (t.method === "cash") {
      cashCount++;
      cashTendered += t.amount;
    } else nonCash += t.amount;
  }
  if (cashCount > 1) error ??= "two_cash";
  if (nonCash > total) error ??= "non_cash_over";

  const cashShare = Math.max(total - nonCash, 0);
  // Rounding applies to the cash share. A remainder of 1-2c rounds to nothing, so it settles by
  // itself even when no cash was taken (card of 20.00 on a 20.01 total).
  const rounding =
    roundCash && cashShare > 0 && (cashCount > 0 || cashShare <= 2)
      ? cashRound(cashShare).adjustment
      : 0;
  const amountDue = total + rounding;
  const cashDue = cashShare + rounding;
  // A cash tender when card/credit already cover the total is a mistake, not change to give.
  if (cashCount > 0 && cashShare === 0) error ??= "bad_amount";
  // What is still short of the (rounded) cash due; without cash that is the whole remainder.
  const short = cashCount > 0 ? Math.max(cashDue - cashTendered, 0) : cashDue;
  if (!error && short > 0) error = "short";
  const change = !error && cashCount > 0 ? cashTendered - cashDue : 0;
  return {
    nonCash,
    cashShare,
    rounding,
    amountDue,
    cashTendered,
    change,
    balance: error === "non_cash_over" ? 0 : short,
    tips,
    ok: !error,
    error,
  };
}

/** The cash a cash share comes to once rounded to 5c (or as it is, when the shop does not round). */
export function cashDueOf(cashShare: number, roundCash = true): number {
  assertInt(cashShare, "cashShare");
  if (cashShare <= 0) return 0;
  return roundCash ? cashShare + cashRound(cashShare).adjustment : cashShare;
}

/** What a card tender should default to: the exact amount still to be settled. */
export function defaultNonCashAmount(total: number, tenders: readonly TenderLine[]): number {
  assertInt(total, "total");
  const taken = tenders.reduce(
    (s, t) => (t.method === "cash" ? s : s + assertInt(t.amount, "amount")),
    0,
  );
  return Math.max(total - taken, 0);
}
