import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { BusinessType } from "@/config/business-type-presets";
import { t, type MessageKey } from "@/lib/i18n";
import { getImportFile } from "@/lib/storage";
import { FIELDS, IMPORT_TYPES, type ImportType } from "./fields";
import { parseUpload, type ImportFileError, type Parsed } from "./parse";
export { settingsProblem } from "./settings";
import { buildItems, type RowError } from "./validate";
import { buildCustomerItems } from "./validate-customers";
import { buildStockItems } from "./validate-stock";

export const mappingSchema = z.partialRecord(z.enum(FIELDS), z.string().max(200).nullable());
export const settingsSchema = z.object({
  mapping: mappingSchema,
  mode: z.enum(["create", "upsert", "count", "received"]),
  matchKey: z.enum(["sku", "barcode", "email"]),
});
export type Settings = z.infer<typeof settingsSchema>;

/** The type of import a request names (default products). */
export const importTypeSchema = z.enum(IMPORT_TYPES);

/** Friendly text for a refused upload. */
export const fileErrorMessage = (e: ImportFileError) => t(`import.err.${e.code}` as MessageKey);

/** What an import would do, whichever type it is. */
export type Analysis = {
  parsed: Parsed;
  /** Every row that cannot be imported (first 100 are shown; the whole list is the problem file). */
  errors: RowError[];
  /** Rows that will be imported (for products: variants). */
  readyRows: number;
  vatDefaulted: number;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
};

/** The type of an import, from its job row (RLS: managers and owners of the shop only). */
export async function jobType(
  supabase: SupabaseClient,
  orgId: string,
  importId: string,
): Promise<ImportType | null> {
  const { data } = await supabase
    .from("import_jobs")
    .select("type")
    .eq("org_id", orgId)
    .eq("id", importId)
    .maybeSingle();
  const parsed = importTypeSchema.safeParse(data?.type);
  return parsed.success ? parsed.data : null;
}

const CHUNK = 1000;

/** The subset of `keys` that already exist, asked in chunks through an RLS-checked function. */
async function existingKeys(
  supabase: SupabaseClient,
  orgId: string,
  kind: "sku" | "barcode" | "email",
  keys: string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    if (kind === "email") {
      const { data, error } = await supabase.rpc("import_existing_emails", {
        p_org: orgId,
        p_emails: part,
      });
      if (error) throw error;
      for (const e of z.array(z.string()).parse(data)) found.add(e);
    } else {
      const { data, error } = await supabase.rpc("import_existing_keys", {
        p_org: orgId,
        p_skus: kind === "sku" ? part : [],
        p_barcodes: kind === "barcode" ? part : [],
      });
      if (error) throw error;
      const res = z
        .object({ skus: z.array(z.string()), barcodes: z.array(z.string()) })
        .parse(data);
      for (const k of kind === "sku" ? res.skus : res.barcodes) found.add(k);
    }
  }
  return found;
}

/**
 * Re-reads the stored upload and checks it with the chosen mapping: what would be created, updated or
 * skipped, and every row that cannot be imported. Reads only (RLS applies).
 */
export async function analyse(
  supabase: SupabaseClient,
  orgId: string,
  importId: string,
  business: BusinessType,
  settings: Settings,
): Promise<Analysis | "expired" | "missing"> {
  const { data: job } = await supabase
    .from("import_jobs")
    .select("file_name, type")
    .eq("org_id", orgId)
    .eq("id", importId)
    .maybeSingle();
  const type = importTypeSchema.safeParse(job?.type);
  if (!job || !type.success) return "missing";
  const bytes = await getImportFile(supabase, orgId, importId);
  if (!bytes) return "expired";
  const parsed = await parseUpload(job.file_name as string, bytes);

  if (type.data === "stock") {
    const key = settings.matchKey === "barcode" ? "barcode" : "sku";
    const built = buildStockItems(
      parsed.rows,
      settings.mapping,
      key,
      settings.mode === "received" ? "received" : "count",
    );
    const existing = await existingKeys(
      supabase,
      orgId,
      key,
      built.items.map((i) => i.key),
    );
    const errors = [...built.errors];
    let matched = 0;
    for (const item of built.items) {
      if (existing.has(item.key)) matched += 1;
      else errors.push({ row: item.rows[0]!, field: key, message: t("import.err.stockNotFound") });
    }
    errors.sort((a, b) => a.row - b.row);
    return {
      parsed,
      errors,
      readyRows: matched,
      vatDefaulted: 0,
      willCreate: 0,
      willUpdate: matched,
      willSkip: 0,
    };
  }

  if (type.data === "customers") {
    const built = buildCustomerItems(importId, parsed.rows, settings.mapping);
    const emails = built.items.map((i) => i.key).filter((k): k is string => !!k);
    const existing = await existingKeys(supabase, orgId, "email", emails);
    let willUpdate = 0;
    let willSkip = 0;
    for (const item of built.items) {
      if (!item.key || !existing.has(item.key)) continue;
      if (settings.mode === "upsert") willUpdate += 1;
      else willSkip += 1;
    }
    return {
      parsed,
      errors: built.errors,
      readyRows: built.readyRows,
      vatDefaulted: 0,
      willCreate: built.readyRows - willUpdate - willSkip,
      willUpdate,
      willSkip,
    };
  }

  const built = buildItems(importId, business, parsed.rows, settings.mapping);
  const key = settings.matchKey === "barcode" ? "barcode" : "sku";
  const keys = built.items
    .flatMap((i) => i.variants)
    .map((v) => v[key])
    .filter((k): k is string => !!k);
  const existing = await existingKeys(supabase, orgId, key, keys);
  let willUpdate = 0;
  let willSkip = 0;
  for (const k of keys) {
    if (!existing.has(k)) continue;
    if (settings.mode === "upsert") willUpdate += 1;
    else willSkip += 1;
  }
  return {
    parsed,
    errors: built.errors,
    readyRows: built.variantCount,
    vatDefaulted: built.vatDefaulted,
    willCreate: built.variantCount - willUpdate - willSkip,
    willUpdate,
    willSkip,
  };
}
