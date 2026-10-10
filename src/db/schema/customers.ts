import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organisations } from "./tenancy";
import { sales } from "./sales";

const orgCol = () =>
  uuid("org_id")
    .notNull()
    .references(() => organisations.id);

/**
 * A shop's customer. Written only through `public.save_customer` and the `ops` device functions;
 * "delete" is `public.anonymise_customer`, which scrubs the row and keeps the id so past sales
 * stay linked (records are kept 6 years). `marketing_consent_at` is set by the server.
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    vatNumber: text("vat_number"),
    address: text("address"),
    notes: text("notes"),
    marketingConsentAt: timestamp("marketing_consent_at", { withTimezone: true }),
    anonymisedAt: timestamp("anonymised_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("customers_org_id_id_key").on(t.orgId, t.id),
    uniqueIndex("customers_org_email_key")
      .on(t.orgId, sql`lower(${t.email})`)
      .where(sql`${t.email} is not null`),
    index("customers_org_name_idx").on(t.orgId, t.name),
    check("customers_name", sql`char_length(btrim(${t.name})) between 1 and 120`),
    check("customers_email", sql`${t.email} is null or char_length(${t.email}) <= 254`),
    check("customers_phone", sql`${t.phone} is null or char_length(${t.phone}) <= 30`),
    check("customers_vat", sql`${t.vatNumber} is null or char_length(${t.vatNumber}) <= 20`),
    check("customers_address", sql`${t.address} is null or char_length(${t.address}) <= 300`),
    check("customers_notes", sql`${t.notes} is null or char_length(${t.notes}) <= 500`),
  ],
);

/** Which customer a sale was rung up for. Append-only; the sale itself is never touched. */
export const saleCustomers = pgTable(
  "sale_customers",
  {
    saleId: uuid("sale_id").primaryKey(),
    orgId: orgCol(),
    customerId: uuid("customer_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "sale_customers_org_sale_fk",
      columns: [t.orgId, t.saleId],
      foreignColumns: [sales.orgId, sales.id],
    }),
    foreignKey({
      name: "sale_customers_org_customer_fk",
      columns: [t.orgId, t.customerId],
      foreignColumns: [customers.orgId, customers.id],
    }),
    index("sale_customers_org_customer_idx").on(t.orgId, t.customerId),
  ],
);
