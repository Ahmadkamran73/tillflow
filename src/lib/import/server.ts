import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { BusinessType } from "@/config/business-type-presets";
import { t, type MessageKey } from "@/lib/i18n";
import { getImportFile } from "@/lib/storage";
import { FIELDS } from "./fields";
import { parseUpload, type ImportFileError, type Parsed } from "./parse";
import { buildItems, type BuildResult } from "./validate";

export const mappingSchema = z.partialRecord(z.enum(FIELDS), z.string().max(200).nullable());
export const settingsSchema = z.object({
  mapping: mappingSchema,
  mode: z.enum(["create", "upsert"]),
  matchKey: z.enum(["sku", "barcode"]),
});
export type Settings = z.infer<typeof settingsSchema>;

/** Friendly text for a refused upload. */
export const fileErrorMessage = (e: ImportFileError) => t(`import.err.${e.code}` as MessageKey);

export type Analysis = {
  parsed: Parsed;
  built: BuildResult;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
};

const CHUNK = 1000;

/**
 * Re-reads the stored upload and checks it with the chosen mapping: what would be created,
 * updated or skipped, and every row that cannot be imported. Reads only (RLS applies).
 */
export async function analyse(
  supabase: SupabaseClient,
  orgId: string,
  importId: string,
  type: BusinessType,
  settings: Settings,
): Promise<Analysis | "expired" | "missing"> {
  const { data: job } = await supabase
    .from("import_jobs")
    .select("file_name")
    .eq("org_id", orgId)
    .eq("id", importId)
    .maybeSingle();
  if (!job) return "missing";
  const bytes = await getImportFile(supabase, orgId, importId);
  if (!bytes) return "expired";
  const parsed = await parseUpload(job.file_name as string, bytes);
  const built = buildItems(importId, type, parsed.rows, settings.mapping);

  const keys = built.items
    .flatMap((i) => i.variants)
    .map((v) => v[settings.matchKey])
    .filter((k): k is string => !!k);
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    const { data, error } = await supabase.rpc("import_existing_keys", {
      p_org: orgId,
      p_skus: settings.matchKey === "sku" ? part : [],
      p_barcodes: settings.matchKey === "barcode" ? part : [],
    });
    if (error) throw error;
    const found = z
      .object({ skus: z.array(z.string()), barcodes: z.array(z.string()) })
      .parse(data);
    for (const k of settings.matchKey === "sku" ? found.skus : found.barcodes) existing.add(k);
  }
  let willUpdate = 0;
  let willSkip = 0;
  for (const k of keys) {
    if (!existing.has(k)) continue;
    if (settings.mode === "upsert") willUpdate += 1;
    else willSkip += 1;
  }
  return {
    parsed,
    built,
    willCreate: built.variantCount - willUpdate - willSkip,
    willUpdate,
    willSkip,
  };
}
