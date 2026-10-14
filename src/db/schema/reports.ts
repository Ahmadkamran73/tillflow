import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { locations, organisations } from "./tenancy";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const orgCol = () =>
  uuid("org_id")
    .notNull()
    .references(() => organisations.id);

/**
 * One shop-local day of trading, cut one way (`dim`). Rebuilt from the stored sale and refund
 * snapshots by `ops.rebuild_summary_day`, never edited by hand, never read from the till. Every
 * amount is a sum of cents already stored on the sale lines, payments and refunds.
 *
 * dim / key: total / all · hour / 00..23 · tender / method|label · vat_rate / rate in basis points
 * · category / category id or none · product / product id or none · staff / cashier id
 * · brand / brand text · size_colour / "size / colour".
 */
export const dailySalesSummary = pgTable(
  "daily_sales_summary",
  {
    orgId: orgCol(),
    locationId: uuid("location_id").notNull(),
    day: date("day").notNull(),
    dim: text("dim").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    salesCount: integer("sales_count").notNull().default(0),
    qty: bigint("qty", { mode: "number" }).notNull().default(0),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull().default(0),
    netCents: bigint("net_cents", { mode: "number" }).notNull().default(0),
    vatCents: bigint("vat_cents", { mode: "number" }).notNull().default(0),
    discountCents: bigint("discount_cents", { mode: "number" }).notNull().default(0),
    tipsCents: bigint("tips_cents", { mode: "number" }).notNull().default(0),
    refundCount: integer("refund_count").notNull().default(0),
    refundQty: bigint("refund_qty", { mode: "number" }).notNull().default(0),
    refundGrossCents: bigint("refund_gross_cents", { mode: "number" }).notNull().default(0),
    refundNetCents: bigint("refund_net_cents", { mode: "number" }).notNull().default(0),
    refundVatCents: bigint("refund_vat_cents", { mode: "number" }).notNull().default(0),
    builtAt: timestamp("built_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.locationId, t.day, t.dim, t.key] }),
    foreignKey({
      name: "daily_sales_summary_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
    index("daily_sales_summary_org_dim_day_idx").on(t.orgId, t.dim, t.day),
    check(
      "daily_sales_summary_dim",
      sql`${t.dim} in ('total', 'hour', 'tender', 'vat_rate', 'category', 'product', 'staff', 'brand', 'size_colour')`,
    ),
    check("daily_sales_summary_key_len", sql`char_length(${t.key}) between 1 and 200`),
  ],
);

/** A shop-local day whose summary is out of date (a sale or refund landed in it). */
export const reportDirtyDays = pgTable(
  "report_dirty_days",
  {
    orgId: orgCol(),
    locationId: uuid("location_id").notNull(),
    day: date("day").notNull(),
    markedAt: timestamp("marked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.locationId, t.day] }),
    foreignKey({
      name: "report_dirty_days_org_location_fk",
      columns: [t.orgId, t.locationId],
      foreignColumns: [locations.orgId, locations.id],
    }),
  ],
);

/**
 * A request for everything a shop holds, as a ZIP of CSV files (GDPR portability). Owners read
 * the row (status only); the file sits in `account_export_files`, which no client can read, and is
 * handed over through `public.get_account_export` once, to an owner, for 7 days.
 */
export const accountExports = pgTable(
  "account_exports",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    requestedBy: uuid("requested_by").notNull(),
    status: text("status").notNull().default("queued"),
    fileName: text("file_name"),
    sizeBytes: integer("size_bytes"),
    /** A short code ("too_large", "failed"), never a message that could hold shop data. */
    errorCode: text("error_code"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [
    unique("account_exports_org_id_id_key").on(t.orgId, t.id),
    index("account_exports_org_requested_idx").on(t.orgId, t.requestedAt),
    check("account_exports_status", sql`${t.status} in ('queued', 'running', 'ready', 'failed')`),
  ],
);

export const accountExportFiles = pgTable(
  "account_export_files",
  {
    exportId: uuid("export_id").primaryKey(),
    orgId: orgCol(),
    bytes: bytea("bytes").notNull(),
  },
  (t) => [
    foreignKey({
      name: "account_export_files_org_export_fk",
      columns: [t.orgId, t.exportId],
      foreignColumns: [accountExports.orgId, accountExports.id],
    }).onDelete("cascade"),
    check("account_export_files_size", sql`octet_length(${t.bytes}) <= 157286400`),
  ],
);
