import { readFileSync } from "node:fs";
import type { RateRow } from "@/lib/money";

/** The seeded Irish rates, parsed from the migration so tests can't drift from the database. */
const sql = readFileSync("supabase/migrations/0002_seed_irish_tax_rates.sql", "utf8");

export const IRISH_RATES: RateRow[] = [
  ...sql.matchAll(/'IE',\s*'(\w+)',\s*'[^']*',\s*(\d+),\s*'([\d-]+)',\s*(?:'([\d-]+)'|null)\)/g),
].map(([, code, bp, validFrom, validTo]) => ({
  country: "IE",
  code: code!,
  rateBp: Number(bp),
  validFrom: validFrom!,
  validTo: validTo ?? null,
}));
