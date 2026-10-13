import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organisations } from "./tenancy";

/**
 * A shop's supplier. v1 is a directory: written only by the supplier import (and later screens)
 * through SECURITY DEFINER functions; clients (managers and owners) can only read. "Delete" is
 * archive: the row stays, so nothing that points at it can break.
 */
export const suppliers = pgTable(
  "suppliers",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    vatNumber: text("vat_number"),
    address: text("address"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("suppliers_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("suppliers_org_name_key")
      .on(t.orgId, sql`lower(btrim(${t.name}))`)
      .where(sql`${t.archivedAt} is null`),
    index("suppliers_org_name_idx").on(t.orgId, t.name),
    check("suppliers_name", sql`char_length(btrim(${t.name})) between 1 and 120`),
    check("suppliers_email", sql`${t.email} is null or char_length(${t.email}) <= 254`),
    check("suppliers_phone", sql`${t.phone} is null or char_length(${t.phone}) <= 30`),
    check("suppliers_vat", sql`${t.vatNumber} is null or char_length(${t.vatNumber}) <= 20`),
    check("suppliers_address", sql`${t.address} is null or char_length(${t.address}) <= 300`),
    check("suppliers_notes", sql`${t.notes} is null or char_length(${t.notes}) <= 500`),
  ],
);
