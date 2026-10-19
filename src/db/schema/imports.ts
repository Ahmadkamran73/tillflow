import { sql } from "drizzle-orm";
import {
  check,
  customType,
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
import { organisations } from "./tenancy";

const orgCol = () =>
  uuid("org_id")
    .notNull()
    .references(() => organisations.id);

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/**
 * One bulk import of products (docs/specs/bulk-import.md). Managers and owners read it; every
 * write goes through public.* / ops.* functions. `batch_id` names the rows it created or changed.
 */
export const importJobs = pgTable(
  "import_jobs",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    createdBy: uuid("created_by").notNull(),
    type: text("type").notNull().default("products"),
    status: text("status").notNull().default("uploaded"),
    mode: text("mode").notNull().default("create"),
    matchKey: text("match_key").notNull().default("sku"),
    fileName: text("file_name").notNull(),
    mapping: jsonb("mapping").notNull().default(sql`'{}'::jsonb`),
    totalRows: integer("total_rows").notNull().default(0),
    processedRows: integer("processed_rows").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    /** First 200 row errors; the full list is rebuilt from the file for the download. */
    errors: jsonb("errors").notNull().default(sql`'[]'::jsonb`),
    batchId: uuid("batch_id").notNull(),
    failure: text("failure"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    undoUntil: timestamp("undo_until", { withTimezone: true }),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (t) => [
    unique("import_jobs_org_id_id_key").on(t.orgId, t.id),
    index("import_jobs_org_created_idx").on(t.orgId, t.createdAt),
    check("import_jobs_type", sql`${t.type} in ('products','stock','customers','suppliers')`),
    check(
      "import_jobs_status",
      sql`${t.status} in ('uploaded','queued','running','done','failed','undone')`,
    ),
    check("import_jobs_mode", sql`${t.mode} in ('create','upsert','count','received')`),
    check("import_jobs_match_key", sql`${t.matchKey} in ('sku','barcode','email','name')`),
    check("import_jobs_rows", sql`${t.totalRows} between 0 and 50000`),
    check("import_jobs_file_name", sql`char_length(${t.fileName}) between 1 and 200`),
  ],
);

/** The uploaded file, kept at most 7 days (`expires_at`); the purge job deletes it. */
export const importFiles = pgTable(
  "import_files",
  {
    importId: uuid("import_id").primaryKey(),
    orgId: orgCol(),
    bytes: bytea("bytes").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '7 days'`),
  },
  (t) => [
    foreignKey({
      name: "import_files_org_import_fk",
      columns: [t.orgId, t.importId],
      foreignColumns: [importJobs.orgId, importJobs.id],
    }).onDelete("cascade"),
    index("import_files_expires_idx").on(t.expiresAt),
    check("import_files_size", sql`octet_length(${t.bytes}) <= 10485760`),
  ],
);

/** A shop's saved column mapping (presets for Square, Lightspeed, Imonggo, Shopify live in code). */
export const importMappings = pgTable(
  "import_mappings",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    /** Which kind of import it is for (a product match is not offered for a customer file). */
    type: text("type").notNull().default("products"),
    name: text("name").notNull(),
    mapping: jsonb("mapping").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("import_mappings_org_type_name_key").on(t.orgId, t.type, t.name),
    check("import_mappings_type", sql`${t.type} in ('products','stock','customers','suppliers')`),
    check("import_mappings_name", sql`char_length(btrim(${t.name})) between 1 and 60`),
    check("import_mappings_size", sql`octet_length(${t.mapping}::text) <= 8000`),
  ],
);

/** What an import did to each variant; undo reads it. Append-only. */
export const importChanges = pgTable(
  "import_changes",
  {
    id: uuid("id").primaryKey(),
    orgId: orgCol(),
    importId: uuid("import_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    action: text("action").notNull(),
    /** Variant, cost and product values before an update (null for a create). */
    before: jsonb("before"),
    openingStock: integer("opening_stock").notNull().default(0),
    /** Stock imports: the change this import made to the variant's stock (undo reverses it). */
    qtyDelta: integer("qty_delta").notNull().default(0),
  },
  (t) => [
    unique("import_changes_import_variant_key").on(t.importId, t.variantId),
    foreignKey({
      name: "import_changes_org_import_fk",
      columns: [t.orgId, t.importId],
      foreignColumns: [importJobs.orgId, importJobs.id],
    }),
    check("import_changes_action", sql`${t.action} in ('created','updated','stock')`),
  ],
);
