import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * File storage for uploads. The only place that knows where the bytes live: today a Postgres
 * table (import_files, reached through role-checked functions), so no extra service or secret.
 * Switching to object storage means changing this file only. Files are kept 7 days.
 */
export const FILE_RETENTION_DAYS = 7;

const hex = (b: Buffer) => `\\x${b.toString("hex")}`;

export async function putImportFile(
  supabase: SupabaseClient,
  a: {
    orgId: string;
    importId: string;
    fileName: string;
    bytes: Buffer;
    totalRows: number;
    type: "products" | "stock" | "customers" | "suppliers";
  },
) {
  return supabase.rpc("create_import", {
    p_org: a.orgId,
    p_id: a.importId,
    p_file_name: a.fileName,
    p_bytes: hex(a.bytes),
    p_total: a.totalRows,
    p_type: a.type,
  });
}

/** The stored upload, or null once it has been purged. */
export async function getImportFile(
  supabase: SupabaseClient,
  orgId: string,
  importId: string,
): Promise<Buffer | null> {
  const { data, error } = await supabase.rpc("get_import_file", { p_org: orgId, p_id: importId });
  if (error) throw error;
  if (typeof data !== "string") return null;
  return Buffer.from(data.startsWith("\\x") ? data.slice(2) : data, "hex");
}
