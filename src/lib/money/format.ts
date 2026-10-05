import { assertInt } from "./vat";

const AMOUNT = /^(-)?(\d{1,7})(?:\.(\d{1,2}))?$/;

/**
 * Parses what a person types ("3", "3.5", "3.50") into integer cents, or null if it is not a
 * plain amount. Pure string maths, so no float ever touches money. Negatives only if allowed.
 */
export function parseCents(input: string, { allowNegative = false } = {}): number | null {
  const m = AMOUNT.exec(input.trim());
  if (!m || (m[1] && !allowNegative)) return null;
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? 0 - cents : cents;
}

const euro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

/** 350 → "€3.50". Display only; never parse the result. */
export function formatCents(cents: number): string {
  return euro.format(assertInt(cents, "cents") / 100);
}

/** 350 → "3.50", the value shown in an input (no symbol, no grouping). */
export function centsToInput(cents: number): string {
  assertInt(cents, "cents");
  const abs = Math.abs(cents);
  return `${cents < 0 ? "-" : ""}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
