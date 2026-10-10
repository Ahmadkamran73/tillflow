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
import { locations, organisations } from "./tenancy";
import { sales } from "./sales";

const orgCol = () =>
  uuid("org_id")
    .notNull()
    .references(() => organisations.id);
const createdAtCol = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAtCol = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

/** A dining area of a location. Never deleted: archived. Written only by `public.save_floor_plan`. */
export const floors = pgTable(
  "floors",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("floors_org_id_id_key").on(t.orgId, t.id),
    foreignKey({
      name: "floors_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    check("floors_name", sql`char_length(btrim(${t.name})) between 1 and 40`),
  ],
);

/** A table on a floor plan: a rectangle on a grid (cells), with seats. Never deleted: archived. */
export const restaurantTables = pgTable(
  "restaurant_tables",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    floorId: uuid("floor_id").notNull(),
    name: text("name").notNull(),
    seats: integer("seats").notNull(),
    shape: text("shape").notNull().default("square"),
    x: integer("x").notNull().default(0),
    y: integer("y").notNull().default(0),
    w: integer("w").notNull().default(2),
    h: integer("h").notNull().default(2),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAtCol(),
    updatedAt: updatedAtCol(),
  },
  (t) => [
    unique("restaurant_tables_org_id_id_key").on(t.orgId, t.id),
    foreignKey({
      name: "restaurant_tables_org_floor_fk",
      columns: [t.orgId, t.floorId],
      foreignColumns: [floors.orgId, floors.id],
    }),
    index("restaurant_tables_org_floor_idx").on(t.orgId, t.floorId),
    check("restaurant_tables_name", sql`char_length(btrim(${t.name})) between 1 and 20`),
    check("restaurant_tables_seats", sql`${t.seats} between 1 and 30`),
    check("restaurant_tables_shape", sql`${t.shape} in ('square', 'round', 'rect')`),
    check(
      "restaurant_tables_grid",
      sql`${t.x} between 0 and 59 and ${t.y} between 0 and 39 and ${t.w} between 1 and 8 and ${t.h} between 1 and 8`,
    ),
  ],
);

export const tabEventKinds = [
  "open",
  "send",
  "fire",
  "transfer",
  "merge",
  "close",
  "void",
] as const;

/**
 * What happened to a restaurant tab on a till, oldest first. Append-only. A tab is a working
 * document on the till; the money is in the sales it was paid with (`sale_tabs`). Events give
 * covers, courses fired and the audit trail. Written only by `ops.record_tab_events`.
 */
export const tabEvents = pgTable(
  "tab_events",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    tabId: uuid("tab_id").notNull(),
    registerId: uuid("register_id").notNull(),
    kind: text("kind").notNull(),
    cashierUserId: uuid("cashier_user_id").notNull(),
    /** The device's clock. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Small, allow-listed facts: table name, covers, course, line count, from/to table. No personal data. */
    detail: jsonb("detail")
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: createdAtCol(),
  },
  (t) => [
    index("tab_events_org_tab_idx").on(t.orgId, t.tabId, t.at),
    index("tab_events_org_at_idx").on(t.orgId, t.at),
    check(
      "tab_events_kind",
      sql`${t.kind} in ('open', 'send', 'fire', 'transfer', 'merge', 'close', 'void')`,
    ),
    check("tab_events_detail_size", sql`pg_column_size(${t.detail}) < 2048`),
  ],
);

/** The tab a sale (a bill, or one part of a split bill) was paid from. Append-only. */
export const saleTabs = pgTable(
  "sale_tabs",
  {
    saleId: uuid("sale_id").primaryKey(),
    orgId: orgCol(),
    tabId: uuid("tab_id").notNull(),
    createdAt: createdAtCol(),
  },
  (t) => [
    foreignKey({
      name: "sale_tabs_org_sale_fk",
      columns: [t.orgId, t.saleId],
      foreignColumns: [sales.orgId, sales.id],
    }),
    index("sale_tabs_org_tab_idx").on(t.orgId, t.tabId),
  ],
);
