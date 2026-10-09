import { assertInt } from "./vat";

/**
 * Cash drawer maths for a shift (X- and Z-reports). All amounts are integer cents.
 * `cashSales` is what cash settled on sales (net of change, including 5c rounding, i.e. the stored
 * cash `payments.amount_cents`); `cashRefunds` is the cash legs of refunds. Card and exchange credit
 * never touch the drawer. The SQL twin is `app.shift_report` (migration 0033).
 */
export interface DrawerFacts {
  float: number;
  cashSales: number;
  cashIn: number;
  cashOut: number;
  cashRefunds: number;
}

/** What should be in the drawer: float + cash sales + cash in - cash out - cash refunds. */
export function expectedCash(f: DrawerFacts): number {
  for (const [k, v] of Object.entries(f)) {
    assertInt(v, k);
    if (v < 0) throw new RangeError(`${k} must be >= 0`);
  }
  return f.float + f.cashSales + f.cashIn - f.cashOut - f.cashRefunds;
}

/** Counted less expected: positive = over, negative = short. The counted cash cannot be negative. */
export function overShort(counted: number, expected: number): number {
  assertInt(counted, "counted");
  assertInt(expected, "expected");
  if (counted < 0) throw new RangeError("counted must be >= 0");
  return counted - expected;
}

export interface CashMovement {
  kind: "in" | "out";
  amount: number;
}

/** Totals of the cash in/out movements of a shift. Each amount is a positive number of cents. */
export function sumMovements(rows: readonly CashMovement[]): { cashIn: number; cashOut: number } {
  let cashIn = 0;
  let cashOut = 0;
  for (const r of rows) {
    assertInt(r.amount, "amount");
    if (r.amount < 1) throw new RangeError("a movement must be at least 1 cent");
    if (r.kind === "in") cashIn += r.amount;
    else cashOut += r.amount;
  }
  return { cashIn, cashOut };
}
