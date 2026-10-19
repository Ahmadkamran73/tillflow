import type { TaxRate } from "@/db/schema/tax";

/** The `tax_rates.code` values (migration 0002). A category's rate can change over time. */
export const TAX_CATEGORIES = [
  "STANDARD",
  "REDUCED",
  "SECOND_REDUCED",
  "ZERO",
  "LIVESTOCK",
  "CATERING",
  "HAIRDRESSING",
] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];

export type RateRow = Pick<TaxRate, "country" | "code" | "rateBp" | "validFrom" | "validTo">;

export type ServiceMode = "eat_in" | "take_away";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The rate in basis points for `category` on `date` (shop-local `YYYY-MM-DD`). Throws if no row
 * or more than one row matches: the database forbids overlaps, but the register's offline copy
 * can't, and a sale must never get a guessed rate.
 */
export function findRateBp(
  rates: readonly RateRow[],
  country: string,
  category: TaxCategory,
  date: string,
): number {
  if (!ISO_DATE.test(date)) throw new RangeError(`date must be YYYY-MM-DD, got ${date}`);
  const rows = rates.filter(
    (r) =>
      r.country === country &&
      r.code === category &&
      r.validFrom <= date &&
      (r.validTo === null || date <= r.validTo),
  );
  if (rows.length !== 1) {
    throw new Error(`${rows.length} ${country} ${category} VAT rates on ${date}, expected 1`);
  }
  return rows[0]!.rateBp;
}

/** The calendar date of `instant` in `timeZone`, e.g. "Europe/Dublin" → "2026-07-01". */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Take-away uses the product's take-away category when it has one. A CATERING product must say
 * what it becomes on take-away (cold food ZERO, a coffee may stay CATERING): falling back to the
 * eat-in rate would silently over-charge, so it throws instead.
 */
export function categoryFor(
  product: { taxCategory: TaxCategory; takeawayTaxCategory?: TaxCategory },
  mode: ServiceMode,
): TaxCategory {
  if (mode === "eat_in") return product.taxCategory;
  if (product.takeawayTaxCategory) return product.takeawayTaxCategory;
  if (product.taxCategory === "CATERING") {
    throw new Error("CATERING product sold take-away has no takeawayTaxCategory");
  }
  return product.taxCategory;
}
