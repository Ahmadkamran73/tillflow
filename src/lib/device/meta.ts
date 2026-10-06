import { z } from "zod";
import { businessTypes } from "@/config/business-type-presets";
import type { RateRow } from "@/lib/money";

/** Parsers for the jsonb the ops.device_* functions return (snake_case from SQL, camelCase here). */

const taxRateRow = z.object({
  country: z.string(),
  code: z.string(),
  rate_bp: z.number(),
  valid_from: z.string(),
  valid_to: z.string().nullable(),
});

export const mapTaxRates = (rows: z.infer<typeof taxRateRow>[]): RateRow[] =>
  rows.map((r) => ({
    country: r.country,
    code: r.code,
    rateBp: r.rate_bp,
    validFrom: r.valid_from,
    validTo: r.valid_to,
  }));

const syncMeta = z.object({
  timezone: z.string(),
  discount_override_bp: z.int().min(0).max(10_000),
  tax_rates: z.array(taxRateRow),
});

/** What sale sync needs about the till's shop (ops.device_sync_meta). */
export function parseSyncMeta(raw: unknown) {
  const m = syncMeta.parse(raw);
  return {
    timezone: m.timezone,
    discountOverrideBp: m.discount_override_bp,
    taxRates: mapTaxRates(m.tax_rates),
  };
}

const feedMeta = z.object({
  org: z.object({
    business_type: z.enum(businessTypes),
    name: z.string(),
    legal_name: z.string().nullable(),
    vat_number: z.string().nullable(),
    discount_override_bp: z.int().min(0).max(10_000),
  }),
  location: z.object({
    id: z.string(),
    timezone: z.string(),
    address: z.string().nullable(),
    eircode: z.string().nullable(),
    receipt_footer: z.string().nullable(),
  }),
  register: z.object({ id: z.string(), name: z.string(), last_seq: z.int().min(0) }),
  tax_rates: z.array(taxRateRow),
  staff: z.array(
    z.object({
      user_id: z.string(),
      display_name: z.string(),
      role: z.enum(["owner", "manager", "cashier"]),
      pin_hash: z.string(),
    }),
  ),
});

/** The shop header, the till itself, tax rates and the staff picker (ops.device_feed_meta). */
export const parseFeedMeta = (raw: unknown) => feedMeta.parse(raw);
