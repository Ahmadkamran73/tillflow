import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod";

export const businessTypes = ["general", "electronics", "clothing", "cafe", "restaurant"] as const;
export const membershipRoles = ["owner", "manager", "cashier"] as const;
export const orgStatuses = ["trial", "active", "read_only", "closed"] as const;

export const businessType = pgEnum("business_type", businessTypes);
export const membershipRole = pgEnum("membership_role", membershipRoles);
export const orgStatus = pgEnum("org_status", orgStatuses);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** The tenant. Its `id` is the org id every other table points at. */
export const organisations = pgTable(
  "organisations",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    vatNumber: text("vat_number"),
    croNumber: text("cro_number"),
    businessType: businessType("business_type").notNull(),
    country: text("country").notNull().default("IE"),
    plan: text("plan").notNull().default("standard"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    status: orgStatus("status").notNull().default("trial"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("organisations_country_len", sql`char_length(${t.country}) = 2`)],
);

/**
 * user_id deliberately has no FK to auth.users so the auth provider stays
 * swappable (see src/lib/auth). location_ids cannot be an FK array; the
 * server validates them against `locations` in the same org.
 */
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    userId: uuid("user_id").notNull(),
    role: membershipRole("role").notNull(),
    pinHash: text("pin_hash"),
    locationIds: uuid("location_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("memberships_org_user_key").on(t.orgId, t.userId),
    index("memberships_user_org_idx").on(t.userId, t.orgId),
  ],
);

export const locations = pgTable(
  "locations",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    name: text("name").notNull(),
    address: text("address"),
    eircode: text("eircode"),
    timezone: text("timezone").notNull().default("Europe/Dublin"),
    receiptFooter: text("receipt_footer"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("locations_org_name_key").on(t.orgId, t.name),
    // Target for composite FKs so a child can never point at another org's location.
    unique("locations_org_id_id_key").on(t.orgId, t.id),
  ],
);

export const registers = pgTable(
  "registers",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    deviceTokenHash: text("device_token_hash"),
    pairedAt: timestamp("paired_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "registers_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    unique("registers_org_location_name_key").on(t.orgId, t.locationId, t.name),
  ],
);

export type Organisation = typeof organisations.$inferSelect;
export type Membership = typeof memberships.$inferSelect;
export type Location = typeof locations.$inferSelect;
export type Register = typeof registers.$inferSelect;

// Input schemas. Organisations are created by the sign-up flow (service role), never by a client insert.
const uuidSchema = z.uuid();
export const organisationUpdateInput = z
  .object({
    name: z.string().trim().min(1).max(120),
    legalName: z.string().trim().max(200).nullable(),
    vatNumber: z.string().trim().max(20).nullable(),
    croNumber: z.string().trim().max(20).nullable(),
    businessType: z.enum(businessTypes),
  })
  .partial();
export const locationInsertInput = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(300).nullish(),
  eircode: z.string().trim().max(10).nullish(),
  timezone: z.string().min(1).default("Europe/Dublin"),
  receiptFooter: z.string().max(500).nullish(),
});
export const locationUpdateInput = locationInsertInput.omit({ id: true, orgId: true }).partial();
export const registerInsertInput = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  locationId: uuidSchema,
  name: z.string().trim().min(1).max(80),
});
export const registerUpdateInput = registerInsertInput.omit({ id: true, orgId: true }).partial();
export const membershipInsertInput = z.object({
  id: uuidSchema,
  orgId: uuidSchema,
  userId: uuidSchema,
  role: z.enum(membershipRoles),
  locationIds: z.array(uuidSchema).default([]),
});
export const membershipUpdateInput = z
  .object({ role: z.enum(membershipRoles), locationIds: z.array(uuidSchema) })
  .partial();
