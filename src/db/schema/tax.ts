import { sql } from "drizzle-orm";
import { check, date, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

/**
 * Global reference data (no org_id): the same effective-dated rates apply to every shop.
 * Read-only for clients; changed only by migration. `valid_to` is the inclusive last day.
 */
export const taxRates = pgTable(
  "tax_rates",
  {
    id: uuid("id").primaryKey(),
    country: text("country").notNull(),
    code: text("code").notNull(),
    description: text("description").notNull(),
    rateBp: integer("rate_bp").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("tax_rates_country_code_from_key").on(t.country, t.code, t.validFrom),
    check("tax_rates_rate_bp_range", sql`${t.rateBp} between 0 and 10000`),
    check("tax_rates_valid_range", sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`),
  ],
);

export type TaxRate = typeof taxRates.$inferSelect;
