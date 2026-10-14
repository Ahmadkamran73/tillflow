import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth";
import { t } from "@/lib/i18n";
import {
  REPORT_DEFS,
  buildTable,
  type CoversRow,
  type ReportId,
  type SerialRow,
  type SummaryRow,
} from "./registry";
import type { ReportParams } from "./params";
import type { ReportTable } from "./table";

/** The database stops a report at this many rows. */
export const ROW_LIMIT = 5000;

const n = z.coerce.number().int();
const summaryRow = z.object({
  day: z.string().nullable(),
  key: z.string(),
  label: z.string(),
  sales_count: n,
  qty: n,
  gross_cents: n,
  net_cents: n,
  vat_cents: n,
  discount_cents: n,
  tips_cents: n,
  refund_count: n,
  refund_qty: n,
  refund_gross_cents: n,
  refund_net_cents: n,
  refund_vat_cents: n,
});
const serialRow = z.object({
  serial: z.string(),
  name: z.string(),
  receipt_seq: n,
  register_name: z.string(),
  completed_at: z.string(),
  returned: z.boolean(),
});
const coversRow = z.object({ day: z.string(), tabs: n, covers: n, sales_cents: n });

export type LoadedReport = { table: ReportTable; truncated: boolean };

/** Raw rows of one report for the signed-in manager (RLS and the role check apply). */
export async function loadRows(
  orgId: string,
  id: ReportId,
  p: ReportParams,
  locationId: string | null = null,
): Promise<{ summary?: SummaryRow[]; serials?: SerialRow[]; covers?: CoversRow[] }> {
  const supabase = await createSupabaseServerClient();
  const src = REPORT_DEFS[id].source;
  const fail = () => new Error("Could not load the report");
  if (src.from === "summary") {
    const { data, error } = await supabase.rpc("report_summary", {
      p_org: orgId,
      p_from: p.from,
      p_to: p.to,
      p_dim: src.dim,
      p_by_day: src.byDay,
      p_location: locationId,
    });
    if (error) throw fail();
    return { summary: z.array(summaryRow).parse(data) };
  }
  if (src.from === "serials") {
    const { data, error } = await supabase.rpc("report_serials", {
      p_org: orgId,
      p_from: p.from,
      p_to: p.to,
      p_search: p.q ?? null,
      p_limit: ROW_LIMIT,
    });
    if (error) throw fail();
    return { serials: z.array(serialRow).parse(data) };
  }
  const { data, error } = await supabase.rpc("report_covers", {
    p_org: orgId,
    p_from: p.from,
    p_to: p.to,
  });
  if (error) throw fail();
  return { covers: z.array(coversRow).parse(data) };
}

/** One report as the table the screen and every export print. */
export async function loadReport(
  orgId: string,
  id: ReportId,
  p: ReportParams,
  timeZone: string,
): Promise<LoadedReport> {
  const rows = await loadRows(orgId, id, p);
  const count = (rows.summary ?? rows.serials ?? rows.covers ?? []).length;
  return {
    table: buildTable(id, rows, t("reports.total"), timeZone),
    truncated: count >= ROW_LIMIT,
  };
}
