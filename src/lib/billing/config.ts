import { z } from "zod";

/**
 * Billing settings come from the environment only: nothing here has a default for the price or the
 * bank details, so a shop is never invoiced from a guess. `parseBillingConfig` returns an error
 * list instead of throwing, so jobs can log it and stop without crashing the worker.
 */

/** IBAN check: country + length shape, then the ISO 7064 mod-97 test. */
export function ibanValid(raw: string): boolean {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const digits = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

const intFromEnv = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a whole number")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

const schema = z.object({
  BILLING_PRICE_CENTS: intFromEnv(1, 10_000_000),
  BILLING_TRIAL_DAYS: intFromEnv(0, 365),
  BILLING_GRACE_DAYS: intFromEnv(0, 365),
  BILLING_INVOICE_DUE_DAYS: intFromEnv(0, 120),
  // A percentage as people write it: 23, 13.5 or 9.25 (at most two decimals). Stored as basis points.
  BILLING_VAT_RATE: z
    .string()
    .trim()
    .regex(/^(\d{1,2}(\.\d{1,2})?|100)$/, "must be a percentage such as 23 or 13.5")
    .transform((s) => {
      const [whole = "0", frac = ""] = s.split(".");
      return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
    })
    .pipe(z.number().int().min(0).max(10_000)),
  // Who the invoice is from, when that differs from the name on the bank account.
  BILLING_SUPPLIER_NAME: z.string().trim().max(100).optional(),
  BILLING_ACCOUNT_NAME: z.string().trim().min(1).max(100),
  BILLING_IBAN: z
    .string()
    .refine(ibanValid, "is not a valid IBAN")
    .transform((s) => s.replace(/\s+/g, "").toUpperCase()),
  BILLING_BIC: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/, "is not a valid BIC"),
  BILLING_VAT_NUMBER: z.string().trim().min(3).max(20),
  BILLING_ADDRESS: z.string().trim().min(1).max(300),
});

export type BillingConfig = {
  priceCents: number;
  trialDays: number;
  graceDays: number;
  invoiceDueDays: number;
  vatRateBp: number;
  /** The bank account holder (payment instructions). */
  accountName: string;
  /** The seller named on invoices: BILLING_SUPPLIER_NAME, else the account holder. */
  supplierName: string;
  iban: string;
  bic: string;
  vatNumber: string;
  address: string;
};

export type BillingConfigResult =
  { ok: true; config: BillingConfig } | { ok: false; errors: string[] };

export function parseBillingConfig(env: Record<string, string | undefined>): BillingConfigResult {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Names and reasons only: never echo a value (bank details are not secrets, but keep the habit).
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${String(i.path[0])} ${i.message}`),
    };
  }
  const v = parsed.data;
  return {
    ok: true,
    config: {
      priceCents: v.BILLING_PRICE_CENTS,
      trialDays: v.BILLING_TRIAL_DAYS,
      graceDays: v.BILLING_GRACE_DAYS,
      invoiceDueDays: v.BILLING_INVOICE_DUE_DAYS,
      vatRateBp: v.BILLING_VAT_RATE,
      accountName: v.BILLING_ACCOUNT_NAME,
      supplierName: v.BILLING_SUPPLIER_NAME || v.BILLING_ACCOUNT_NAME,
      iban: v.BILLING_IBAN,
      bic: v.BILLING_BIC,
      vatNumber: v.BILLING_VAT_NUMBER,
      address: v.BILLING_ADDRESS,
    },
  };
}

/** The configuration in force, or the reasons it is unusable. Read fresh so a restart is enough. */
export function loadBillingConfig(): BillingConfigResult {
  return parseBillingConfig(process.env);
}

/** IBAN in groups of four for reading aloud / typing. */
export function formatIban(iban: string): string {
  return iban.replace(/(.{4})/g, "$1 ").trim();
}
