import { assertInt } from "./vat";

/** Change owed for a cash tender; the tender must cover the amount due. */
export function changeDue(tendered: number, due: number): number {
  assertInt(tendered, "tendered");
  assertInt(due, "due");
  if (tendered < due) throw new RangeError(`tendered ${tendered} is less than due ${due}`);
  return tendered - due;
}

const NOTES = [500, 1000, 2000, 5000]; // €5, €10, €20, €50

/**
 * Quick-cash amounts for a cash due: the exact amount first, then the next amount up for each
 * note size (rounded up to a multiple of it), deduplicated, at most 4 in all.
 */
export function quickCash(due: number): number[] {
  assertInt(due, "due");
  if (due <= 0) return [];
  const out = [due];
  for (const n of NOTES) {
    const up = Math.ceil(due / n) * n;
    if (!out.includes(up)) out.push(up);
  }
  return out.slice(0, 4);
}
