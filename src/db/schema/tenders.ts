import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { locations, organisations } from "./tenancy";

export const tenderMethods = ["cash", "card", "voucher"] as const;

/**
 * The ways a location takes payment, e.g. "Cash", "Card – AIB terminal", "Card – SumUp". A card
 * tender only records that the shop's own terminal approved it; no card data is ever held. Never
 * deleted (payments point at them): archived instead. Each location has exactly one active cash
 * type, which cannot be archived.
 */
export const tenderTypes = pgTable(
  "tender_types",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    locationId: uuid("location_id").notNull(),
    method: text("method").notNull(),
    label: text("label").notNull(),
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Target for composite FKs so a payment can never point at another org's tender type.
    unique("tender_types_org_id_id_key").on(t.orgId, t.id),
    foreignKey({
      name: "tender_types_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }).onDelete("cascade"), // a location with no sales can still be deleted; payments keep their type (no cascade there)
    index("tender_types_org_location_idx").on(t.orgId, t.locationId, t.sort),
    uniqueIndex("tender_types_one_cash_key")
      .on(t.locationId)
      .where(sql`${t.method} = 'cash'`),
    check("tender_types_method", sql`${t.method} in ('cash', 'card', 'voucher')`),
    check("tender_types_label", sql`char_length(btrim(${t.label})) between 1 and 40`),
  ],
);

export type TenderType = typeof tenderTypes.$inferSelect;
