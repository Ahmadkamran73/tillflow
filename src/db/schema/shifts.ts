import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { locations, organisations, registers } from "./tenancy";

const orgCol = () =>
  uuid("org_id")
    .notNull()
    .references(() => organisations.id);
const createdAtCol = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const shiftReviewFlags = ["z_differs", "counts_differ", "rejected_excluded"] as const;

/**
 * A trading shift on one till, opened with a float. Append-only: "open" means no row in
 * `shift_closes`. Written only by `ops.record_shift_open`; `id` is the device's UUIDv7.
 */
export const shifts = pgTable(
  "shifts",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    registerId: uuid("register_id").notNull(),
    locationId: uuid("location_id").notNull(),
    openedBy: uuid("opened_by").notNull(),
    /** The device's clock, kept for audit. */
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    floatCents: integer("float_cents").notNull(),
    createdAt: createdAtCol(),
  },
  (t) => [
    unique("shifts_org_id_id_key").on(t.orgId, t.id),
    foreignKey({
      name: "shifts_org_register_fk",
      columns: [t.orgId, t.registerId],
      foreignColumns: [registers.orgId, registers.id],
    }),
    foreignKey({
      name: "shifts_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    index("shifts_org_register_idx").on(t.orgId, t.registerId, t.openedAt),
    check("shifts_float", sql`${t.floatCents} between 0 and 10000000`),
  ],
);

/** Cash put in or taken out of the drawer during a shift, with a required note. Append-only. */
export const cashMovements = pgTable(
  "cash_movements",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    shiftId: uuid("shift_id").notNull(),
    kind: text("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    note: text("note").notNull(),
    cashierUserId: uuid("cashier_user_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAtCol(),
  },
  (t) => [
    foreignKey({
      name: "cash_movements_org_shift_fk",
      columns: [t.orgId, t.shiftId],
      foreignColumns: [shifts.orgId, shifts.id],
    }),
    index("cash_movements_org_shift_idx").on(t.orgId, t.shiftId),
    check("cash_movements_kind", sql`${t.kind} in ('in', 'out')`),
    check("cash_movements_amount", sql`${t.amountCents} between 1 and 10000000`),
    check("cash_movements_note", sql`char_length(btrim(${t.note})) between 1 and 200`),
  ],
);

/**
 * The Z-report: the immutable close of a shift. `report` is the server's snapshot; expected cash
 * and over/short are worked out by the server, never taken from the till.
 */
export const shiftCloses = pgTable(
  "shift_closes",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    shiftId: uuid("shift_id").notNull(),
    registerId: uuid("register_id").notNull(),
    /** Z number per till (printed Z0007), gap-free, assigned by the till and checked here. */
    zSeq: integer("z_seq").notNull(),
    closedBy: uuid("closed_by").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    countedCents: integer("counted_cents").notNull(),
    expectedCents: integer("expected_cents").notNull(),
    overShortCents: integer("over_short_cents").notNull(),
    report: jsonb("report").notNull(),
    reviewFlags: text("review_flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAtCol(),
  },
  (t) => [
    unique("shift_closes_shift_key").on(t.shiftId),
    unique("shift_closes_register_seq_key").on(t.orgId, t.registerId, t.zSeq),
    foreignKey({
      name: "shift_closes_org_shift_fk",
      columns: [t.orgId, t.shiftId],
      foreignColumns: [shifts.orgId, shifts.id],
    }),
    index("shift_closes_org_closed_idx").on(t.orgId, t.closedAt),
    check("shift_closes_z_seq", sql`${t.zSeq} between 1 and 99999999`),
    check("shift_closes_counted", sql`${t.countedCents} between 0 and 100000000`),
    check(
      "shift_closes_over_short",
      sql`${t.overShortCents} = ${t.countedCents} - ${t.expectedCents}`,
    ),
    check(
      "shift_closes_review_flags",
      sql`${t.reviewFlags} <@ array['z_differs', 'counts_differ', 'rejected_excluded']::text[]`,
    ),
    check("shift_closes_report_size", sql`pg_column_size(${t.report}) <= 65536`),
  ],
);

/** Links a sale or refund to the shift it was rung in. Append-only; one shift per document. */
export const shiftDocuments = pgTable(
  "shift_documents",
  {
    docId: uuid("doc_id").primaryKey(),
    orgId: orgCol(),
    shiftId: uuid("shift_id").notNull(),
    kind: text("kind").notNull(),
    createdAt: createdAtCol(),
  },
  (t) => [
    foreignKey({
      name: "shift_documents_org_shift_fk",
      columns: [t.orgId, t.shiftId],
      foreignColumns: [shifts.orgId, shifts.id],
    }),
    index("shift_documents_org_shift_idx").on(t.orgId, t.shiftId, t.kind),
    check("shift_documents_kind", sql`${t.kind} in ('sale', 'refund')`),
  ],
);

export type Shift = typeof shifts.$inferSelect;
export type ShiftClose = typeof shiftCloses.$inferSelect;
