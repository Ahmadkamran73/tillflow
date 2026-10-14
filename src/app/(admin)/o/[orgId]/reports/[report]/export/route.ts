import type { NextRequest } from "next/server";
import { authorizeApi } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { reportError } from "@/lib/errors";
import {
  CONTENT_TYPES,
  EXPORT_FORMATS,
  toCsv,
  toXlsx,
  type ExportFormat,
} from "@/lib/export/tabular";
import { toPdf } from "@/lib/export/pdf";
import { localDate } from "@/lib/money";
import { getOrganisation } from "@/lib/org";
import { rateLimit } from "@/lib/rate-limit";
import { loadReport } from "@/lib/reports/data";
import { reportParams } from "@/lib/reports/params";
import { dayLabel, isReportId, reportsFor } from "@/lib/reports/registry";

export const dynamic = "force-dynamic";

/**
 * GET /o/<orgId>/reports/<report>/export?format=csv|xlsx|pdf&from=&to=&q=
 * Exactly what the screen shows for the same dates: the same parse, the same loader, the same
 * table. Owner or manager only, 30 per hour per user. A report reads at most 5,000 rows, so it is
 * made while the request waits; only the whole-account export is a background job.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; report: string }> },
) {
  const { orgId, report } = await params;
  const auth = await authorizeApi(["owner", "manager"], orgId);
  if (!auth.ok) return new Response(null, { status: auth.status });
  if (!isReportId(report)) return new Response(null, { status: 404 });

  const sp = request.nextUrl.searchParams;
  const format = sp.get("format") as ExportFormat | null;
  if (!format || !EXPORT_FORMATS.includes(format)) return new Response(null, { status: 400 });
  const p = reportParams.safeParse({
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    q: sp.get("q") || undefined,
  });
  if (!p.success) return new Response(null, { status: 400 });

  const [org, location] = await Promise.all([getOrganisation(orgId), getLocation(orgId)]);
  if (!org || !location || !reportsFor(org.businessType).includes(report)) {
    return new Response(null, { status: 404 });
  }

  const limit = await rateLimit("report-export", auth.user.id);
  // A failed download is sent back to the report with a message, not saved as a text file.
  const back = (flag: "limit" | "failed") =>
    Response.redirect(
      new URL(
        `/o/${orgId}/reports/${report}?${new URLSearchParams({ from: p.data.from, to: p.data.to, export: flag })}`,
        request.url,
      ),
      303,
    );
  if (!limit.allowed) return back("limit");

  try {
    const { table } = await loadReport(orgId, report, p.data, location.timezone);
    const meta = {
      shop: org.name,
      range:
        p.data.from === p.data.to
          ? dayLabel(p.data.from)
          : `${dayLabel(p.data.from)} - ${dayLabel(p.data.to)}`,
      madeAt: new Intl.DateTimeFormat("en-IE", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: location.timezone,
      }).format(new Date()),
    };
    const body =
      format === "csv"
        ? toCsv(table)
        : format === "xlsx"
          ? new Uint8Array(await toXlsx(table, meta))
          : new Uint8Array(await toPdf(table, meta));
    const name = `${report}-${p.data.from}-${p.data.to}-${localDate(new Date(), location.timezone)}`;
    return new Response(body, {
      headers: {
        "Content-Type": CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="${name}.${format}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    await reportError(error, { source: "server", route: "report-export" });
    return back("failed");
  }
}
