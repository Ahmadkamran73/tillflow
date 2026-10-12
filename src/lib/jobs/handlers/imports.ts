import "server-only";
import { z } from "zod";
import type { BusinessType } from "@/config/business-type-presets";
import { buildItems, type RowError } from "@/lib/import/validate";
import { parseUpload } from "@/lib/import/parse";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import {
  importApplyBatch,
  importBegin,
  importFile,
  importFinish,
  importPurge,
} from "@/lib/ops/db";
import { orgJobPayload, type JobHandler } from "../boss";

const BATCH = 500;
const KEPT_ERRORS = 200; // the rest are rebuilt from the file for the download

/** SQLSTATE the database answered with, to a sentence. Never includes the data itself. */
const dbMessage = (code?: string) =>
  code === "23505" ? t("import.err.dbDuplicate") : t("import.err.db");

/**
 * Runs a confirmed product import: reads the stored file, validates it again (the preview is not
 * trusted), and writes it 500 products at a time through ops.import_apply_batch. Safe to run twice:
 * ids come from the import id and row, and the database remembers what this import already did.
 */
export async function runProductImport(data: z.infer<typeof importPayload>): Promise<void> {
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
    const built = buildItems(
      data.import_id,
      start.business_type as BusinessType,
      parsed.rows,
      start.mapping,
    );
    const errors: RowError[] = [...built.errors];

    for (let i = 0; i < built.items.length; i += BATCH) {
      const slice = built.items.slice(i, i + BATCH);
      const result = await importApplyBatch({
        import_id: data.import_id,
        user_id: data.user_id,
        items: slice,
      });
      for (const r of result) {
        if (r.status !== "error") continue;
        const item = slice.find((s) => s.ref === r.ref);
        for (const row of item?.rows ?? []) {
          errors.push({ row, field: "row", message: dbMessage(r.code) });
        }
      }
    }
    errors.sort((a, b) => a.row - b.row);
    await importFinish(
      data.import_id,
      true,
      new Set(errors.map((e) => e.row)).size,
      errors.slice(0, KEPT_ERRORS),
      null,
    );
    logger.info({ job: "import-products", rows: parsed.rows.length }, "product import finished");
  } catch (error) {
    await importFinish(data.import_id, false, 0, [], "unexpected_error");
    throw error;
  }
}

const importPayload = orgJobPayload.extend({ import_id: z.uuid() });

export const IMPORT_HANDLERS: JobHandler[] = [
  {
    name: "import-products",
    schema: importPayload,
    // 50,000 rows: well over the 5-minute default; no retry storm on a failed import.
    queue: { retryLimit: 0, expireInSeconds: 3600 },
    handle: (data) => runProductImport(importPayload.parse(data)),
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
