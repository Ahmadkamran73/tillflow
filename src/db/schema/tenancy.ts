import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
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
    /** Set once by public.complete_onboarding; never client-writable. */
    onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
    /** Set by public.confirm_vat_rates (owner, audit-logged); never client-writable. */
    vatRatesConfirmedAt: timestamp("vat_rates_confirmed_at", { withTimezone: true }),
    vatRatesConfirmedBy: uuid("vat_rates_confirmed_by"),
    /** A discount above this share (basis points) of a line or sale needs a manager PIN. */
    discountOverrideBp: integer("discount_override_bp").notNull().default(1000),
    status: orgStatus("status").notNull().default("trial"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("organisations_country_len", sql`char_length(${t.country}) = 2`),
    // Shape only; the mod-23 check digit is verified in src/lib/onboarding.ts.
    check("organisations_discount_override_bp", sql`${t.discountOverrideBp} between 0 and 10000`),
    check(
      "organisations_vat_number_ie",
      sql`${t.vatNumber} is null or ${t.vatNumber} ~ '^IE([0-9]{7}[A-W][A-IW]?|[0-9][A-Z+*][0-9]{5}[A-W])$'`,
    ),
  ],
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
    /** Name shown on the till's staff picker. */
    displayName: text("display_name"),
    pinSetAt: timestamp("pin_set_at", { withTimezone: true }),
    /** Attempts reserved since the last good PIN; the 5th failure sets pinLockedUntil. */
    pinFailedCount: integer("pin_failed_count").notNull().default(0),
    pinLockedUntil: timestamp("pin_locked_until", { withTimezone: true }),
    /**
     * A cashier added by a manager for the till only: no login account. Such a row never
     * authorises a session (app.org_ids_with_roles skips it), even if its id ever matched a user.
     */
    tillOnly: boolean("till_only").notNull().default(false),
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
    // Target for composite FKs so a sale can never point at another org's register.
    unique("registers_org_id_id_key").on(t.orgId, t.id),
  ],
);

/**
 * One-time pairing codes (8 characters, 10 minutes). Only the hash is stored; the code is shown
 * once to the manager. Written by public.create_pairing_code / ops.pair_register, never by clients.
 */
export const registerPairingCodes = pgTable(
  "register_pairing_codes",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    registerId: uuid("register_id").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "register_pairing_codes_org_register_fk",
      columns: [t.orgId, t.registerId],
      foreignColumns: [registers.orgId, registers.id],
    }),
    unique("register_pairing_codes_code_hash_key").on(t.codeHash),
    index("register_pairing_codes_org_register_idx").on(t.orgId, t.registerId),
  ],
);

/**
 * A manager's PIN, checked by the server (ops.issue_approval), turned into a single-use proof the
 * till attaches to one sale or event. The database derives the approver from this row, never from
 * anything the till says. Valid 30 minutes from creation, for one register and one purpose.
 */
export const registerApprovals = pgTable(
  "register_approvals",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organisations.id),
    registerId: uuid("register_id").notNull(),
    approverUserId: uuid("approver_user_id").notNull(),
    purpose: text("purpose").notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    /** The sale or event the approval was spent on. */
    consumedFor: uuid("consumed_for"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "register_approvals_org_register_fk",
      columns: [t.orgId, t.registerId],
      foreignColumns: [registers.orgId, registers.id],
    }),
    check("register_approvals_purpose", sql`${t.purpose} in ('discount', 'no_sale', 'refund')`),
    index("register_approvals_org_register_idx").on(t.orgId, t.registerId, t.createdAt),
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
