import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DownloadIcon } from "lucide-react";
import { FocusMessage } from "@/components/back-office/focus-message";
import { Button } from "@/components/ui/button";
import { ReportTableView } from "@/components/reports/report-table";
import { requireRole } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { localDate } from "@/lib/money";
import { getOrganisation } from "@/lib/org";
import { loadReport, ROW_LIMIT } from "@/lib/reports/data";
import { parseReportParams, presets, reportParams } from "@/lib/reports/params";
import { REPORT_DEFS, isReportId, reportsFor } from "@/lib/reports/registry";

type Search = Record<string, string | string[] | undefined>;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ report: string }>;
}): Promise<Metadata> {
  const { report } = await params;
  const title = isReportId(report) ? t(REPORT_DEFS[report].title) : t("reports.title");
  return { title: `${title} · ${t("app.name")}` };
}

const pill = "border-input flex h-12 items-center rounded-full border px-5 text-sm font-medium";
const field =
  "border-input bg-background h-12 rounded-lg border px-3 text-base outline-none focus-visible:ring-3 md:text-sm";

/** One report for a range of shop-local days, with the filter bar and the downloads. */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; report: string }>;
  searchParams: Promise<Search>;
}) {
  const { orgId, report } = await params;
  await requireRole(["owner", "manager"], orgId);
  if (!isReportId(report)) notFound();
  const [org, location] = await Promise.all([getOrganisation(orgId), getLocation(orgId)]);
  if (!org || !location || !reportsFor(org.businessType).includes(report)) notFound();

  const raw = await searchParams;
  const today = localDate(new Date(), location.timezone);
  const p = parseReportParams(raw, today);
  const asked = raw.from !== undefined || raw.to !== undefined;
  const invalid =
    asked &&
    !reportParams.safeParse({
      from: Array.isArray(raw.from) ? raw.from[0] : raw.from,
      to: Array.isArray(raw.to) ? raw.to[0] : raw.to,
    }).success;

  const { table, truncated } = await loadReport(orgId, report, p, location.timezone);
  const title = t(REPORT_DEFS[report].title);
  const qs = new URLSearchParams({ from: p.from, to: p.to, ...(p.q ? { q: p.q } : {}) });
  const exportHref = (format: string) =>
    `/o/${orgId}/reports/${report}/export?${new URLSearchParams({ format, ...Object.fromEntries(qs) })}`;
  const range = (r: { from: string; to: string }) =>
    `/o/${orgId}/reports/${report}?${new URLSearchParams(r)}`;
  const quick = presets(today);
  const quickKeys = ["today", "last7", "last30", "thisMonth", "lastMonth"] as const;
  const isVat = report === "vat";
  const exportFlag = Array.isArray(raw.export) ? raw.export[0] : raw.export;
  const current = (r: { from: string; to: string }) => r.from === p.from && r.to === p.to;
  const searchable = report === "serials";

  return (
    <section className="flex max-w-6xl flex-col gap-4">
      <div>
        <Link
          href={`/o/${orgId}/reports`}
          className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
        >
          {t("reports.back")}
        </Link>
        <h1 className="text-title font-semibold tracking-tight">{title}</h1>
        <p className="text-muted-foreground text-sm">{t(REPORT_DEFS[report].blurb)}</p>
      </div>

      <form
        method="get"
        role="search"
        aria-label={t("reports.filter.label")}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="from" className="text-sm font-medium">
            {t("reports.filter.from")}
          </label>
          <input
            id="from"
            name="from"
            type="date"
            required
            defaultValue={p.from}
            className={field}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "range-error" : undefined}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="to" className="text-sm font-medium">
            {t("reports.filter.to")}
          </label>
          <input id="to" name="to" type="date" required defaultValue={p.to} className={field} aria-invalid={invalid || undefined} aria-describedby={invalid ? "range-error" : undefined} />
        </div>
        {searchable ? (
          <div className="flex min-w-48 flex-col gap-1.5">
            <label htmlFor="q" className="text-sm font-medium">
              {t("reports.filter.search")}
            </label>
            <input
              id="q"
              name="q"
              type="search"
              maxLength={60}
              defaultValue={p.q}
              autoComplete="off"
              className={field}
            />
          </div>
        ) : null}
        <Button type="submit" className="h-12 px-5">
          {t("reports.filter.show")}
        </Button>
      </form>
      <FocusMessage id="range-error" message={invalid ? t("reports.filter.invalid") : ""} urgent />

      <FocusMessage
        message={
          exportFlag === "limit"
            ? t("reports.export.limit")
            : exportFlag === "failed"
              ? t("reports.export.failed")
              : ""
        }
        urgent
      />

      <nav aria-label={t("reports.preset.label")} className="flex flex-wrap gap-2">
        {quickKeys.map((k) => (
          <Link
            key={k}
            href={range(quick[k])}
            aria-current={current(quick[k]) ? "true" : undefined}
            className={`${pill} ${current(quick[k]) ? "bg-primary text-primary-foreground" : ""}`}
          >
            {current(quick[k]) ? "✓ " : ""}
            {t(`reports.preset.${k}`)}
          </Link>
        ))}
        {isVat ? (
          <>
            <Link
              href={range(quick.vatPeriod)}
              aria-current={current(quick.vatPeriod) ? "true" : undefined}
              className={`${pill} ${current(quick.vatPeriod) ? "bg-primary text-primary-foreground" : ""}`}
            >
              {current(quick.vatPeriod) ? "✓ " : ""}
              {t("reports.preset.vatPeriod")}
            </Link>
            <Link
              href={range(quick.lastVatPeriod)}
              aria-current={current(quick.lastVatPeriod) ? "true" : undefined}
              className={`${pill} ${current(quick.lastVatPeriod) ? "bg-primary text-primary-foreground" : ""}`}
            >
              {current(quick.lastVatPeriod) ? "✓ " : ""}
              {t("reports.preset.lastVatPeriod")}
            </Link>
          </>
        ) : null}
      </nav>

      {table.rows.length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="text-heading font-semibold">{t("reports.empty")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("reports.emptyBody")}</p>
        </div>
      ) : (
        <ReportTableView table={table} />
      )}

      {truncated ? (
        <p role="status" className="text-sm">
          {t("reports.note.truncated", { n: ROW_LIMIT })}
        </p>
      ) : null}
      <p className="text-muted-foreground max-w-3xl text-sm">
        {isVat ? t("reports.note.vat") : t("reports.note.refunds")}
      </p>

      {table.rows.length > 0 ? (
        <div className="flex flex-col gap-2" role="group" aria-label={t("reports.export.label")}>
          <div className="flex flex-wrap gap-2">
            {(["csv", "xlsx", "pdf"] as const).map((f) => (
              <a
                key={f}
                href={exportHref(f)}
                download
                className="border-input inline-flex h-12 items-center gap-2 rounded-full border px-5 text-sm font-medium"
              >
                <DownloadIcon aria-hidden className="size-4" />
                {t(`reports.export.${f}`)}
                <span className="sr-only"> ({title})</span>
              </a>
            ))}
          </div>
          <p className="text-muted-foreground text-sm">{t("reports.export.hint")}</p>
        </div>
      ) : null}
    </section>
  );
}
