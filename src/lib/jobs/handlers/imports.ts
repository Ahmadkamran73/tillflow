import "server-only";
import { z } from "zod";
import type { BusinessType } from "@/config/business-type-presets";
import { buildItems, type RowError } from "@/lib/import/validate";
import { buildCustomerItems } from "@/lib/import/validate-customers";
import { buildSupplierItems } from "@/lib/import/validate-suppliers";
import { buildStockItems } from "@/lib/import/validate-stock";
import { parseUpload } from "@/lib/import/parse";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import {
  importApplyBatch,
  importApplyCustomers,
  importApplySuppliers,
  importApplyStock,
  importBegin,
  importFile,
  importFinish,
  importPurge,
  type ImportBatchResult,
} from "@/lib/ops/db";
import { orgJobPayload, type JobHandler } from "../boss";

const BATCH = 500;
const KEPT_ERRORS = 200; // the rest are rebuilt from the file for the download

/** SQLSTATE the database answered with, to a sentence. Never includes the data itself. */
const dbMessage = (type: string, code?: string) => {
  if (code === "23505")
    return t(
      type === "customers"
        ? "import.err.dbEmailTaken"
        : type === "suppliers"
          ? "import.err.dbNameTaken"
          : "import.err.dbDuplicate",
    );
  if (code === "P0002") return t("import.err.dbNotFound");
  if (code === "22023" && type === "stock") return t("import.err.dbInvalid");
  return t("import.err.db");
};

/** Sends `items` in batches and turns each refused item into error rows. */
async function applyAll<T extends { ref: string; rows: number[] }>(
  type: string,
  items: T[],
  send: (slice: T[]) => Promise<ImportBatchResult>,
  errors: RowError[],
) {
  for (let i = 0; i < items.length; i += BATCH) {
    const slice = items.slice(i, i + BATCH);
    for (const r of await send(slice)) {
      if (r.status !== "error") continue;
      const item = slice.find((s) => s.ref === r.ref);
      for (const row of item?.rows ?? []) {
        errors.push({ row, field: "row", message: dbMessage(type, r.code) });
      }
    }
  }
}

/**
 * Runs a confirmed import (products, stock levels or customers): reads the stored file, validates it
 * again (the preview is not trusted), and writes it 500 rows at a time through the matching
 * ops.import_apply_* function. Safe to run twice: ids come from the import id and row, and the
 * database remembers what this import already did.
 */
export async function runImport(data: z.infer<typeof importPayload>): Promise<void> {
  const start = await importBegin(data.import_id, data.user_id);
  if (!start) return;
  try {
    if (start.org_id !== data.org_id) throw new Error("import does not belong to this shop");
    const bytes = await importFile(data.import_id);
    if (!bytes) {
      await importFinish(data.import_id, false, 0, [], "file_expired");
      return;
    }
    const parsed = await parseUpload(start.file_name, bytes);
    const errors: RowError[] = [];
    const base = { import_id: data.import_id, user_id: data.user_id };
    const type = start.type ?? "products";

    if (type === "stock") {
      const built = buildStockItems(
        parsed.rows,
        start.mapping,
        start.match_key === "barcode" ? "barcode" : "sku",
        start.mode === "received" ? "received" : "count",
      );
      errors.push(...built.errors);
      await applyAll(type, built.items, (items) => importApplyStock({ ...base, items }), errors);
    } else if (type === "suppliers") {
      const built = buildSupplierItems(data.import_id, parsed.rows, start.mapping);
      errors.push(...built.errors);
      await applyAll(
        type,
        built.items,
        (items) => importApplySuppliers({ ...base, items }),
        errors,
      );
    } else if (type === "customers") {
      const built = buildCustomerItems(data.import_id, parsed.rows, start.mapping);
      errors.push(...built.errors);
      await applyAll(
        type,
        built.items,
        (items) => importApplyCustomers({ ...base, items }),
        errors,
      );
    } else {
      const built = buildItems(
        data.import_id,
        start.business_type as BusinessType,
        parsed.rows,
        start.mapping,
      );
      errors.push(...built.errors);
      await applyAll(type, built.items, (items) => importApplyBatch({ ...base, items }), errors);
    }

    errors.sort((a, b) => a.row - b.row);
    await importFinish(
      data.import_id,
      true,
      new Set(errors.map((e) => e.row)).size,
      errors.slice(0, KEPT_ERRORS),
      null,
    );
    // Counts only: customer files hold personal data and nothing from them is ever logged.
    logger.info({ job: "import", type, rows: parsed.rows.length }, "import finished");
  } catch (error) {
    await importFinish(data.import_id, false, 0, [], "unexpected_error");
    throw error;
  }
}
/** The job was first written for products only; the name stays for the tests that import it. */
export const runProductImport = runImport;

const importPayload = orgJobPayload.extend({ import_id: z.uuid() });

export const IMPORT_HANDLERS: JobHandler[] = [
  {
    // One queue for every import type: the job row says which one it is.
    name: "import-products",
    schema: importPayload,
    // 50,000 rows: well over the 5-minute default; no retry storm on a failed import.
    queue: { retryLimit: 0, expireInSeconds: 3600 },
    handle: (data) => runImport(importPayload.parse(data)),
  },
  {
    name: "import-purge",
    schema: z.object({}),
    cron: "37 * * * *",
    handle: async () => {
      const removed = await importPurge();
      logger.info({ job: "import-purge", removed }, "expired import files removed");
    },
  },
];
