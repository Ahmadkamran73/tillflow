import type { Metadata } from "next";
import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { t, type MessageKey } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { rateLabel, zNumber, type ShiftReport } from "@/lib/shift-report";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: `${t("shifts.title")} · ${t("app.name")}` };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function Rows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="flex flex-col gap-1 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-4">
          <dt>{label}</dt>
          <dd className="font-mono tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

type RateRow = { rate_bp: number; net_cents: number; vat_cents: number; gross_cents: number };

function RateTable({ title, rows }: { title: string; rows: RateRow[] }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm">{t("shifts.report.none")}</p>
      ) : (
        <Table>
          <caption className="sr-only">{title}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("shifts.report.rate")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("shifts.report.net")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("shifts.report.vatCol")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("shifts.report.gross")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.rate_bp}>
                <TableHead scope="row" className="font-normal">
                  {rateLabel(r.rate_bp)}
                </TableHead>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCents(Number(r.net_cents))}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCents(Number(r.vat_cents))}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCents(Number(r.gross_cents))}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

type TenderRow = { label: string; n: number; amount: number; tip: number };

function TenderTable({ title, rows }: { title: string; rows: TenderRow[] }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h3 className="font-semibold">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm">{t("shifts.report.none")}</p>
      ) : (
        <Table>
          <caption className="sr-only">{title}</caption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("shifts.report.type")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("shifts.report.number")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("shifts.report.amount")}
              </TableHead>
              <TableHead scope="col" className="text-right">
                {t("shifts.report.tips")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableHead scope="row" className="font-normal">
                  {r.label}
                </TableHead>
                <TableCell className="text-right tabular-nums">{r.n}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCents(r.amount)}
                </TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCents(r.tip)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** The X-report of an open shift (live) or the stored Z-report of a closed one. */
export default async function ShiftReportPage({
  params,
}: {
  params: Promise<{ orgId: string; shiftId: string }>;
}) {
  const { orgId, shiftId } = await params;
  await requireRole(["owner", "manager"], orgId);
  if (!UUID.test(shiftId)) notFound();
  const location = await getLocation(orgId);
  if (!location) notFound();

  const supabase = await createSupabaseServerClient();
  const [report, shift, registers] = await Promise.all([
    supabase.rpc("get_shift_report", { p_org: orgId, p_shift: shiftId }),
    supabase
      .from("shifts")
      .select("register_id, opened_at")
      .eq("org_id", orgId)
      .eq("id", shiftId)
      .maybeSingle(),
    supabase.from("registers").select("id, name").eq("org_id", orgId),
  ]);
  if (report.error || shift.error || registers.error) throw new Error("Could not load the report");
  const r = report.data as ShiftReport | null;
  const sh = shift.data;
  if (!r || !sh) notFound();
  const till =
    (registers.data ?? []).find((x) => x.id === sh.register_id)?.name ?? t("shifts.tillFallback");
  const time = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: location.timezone,
  });
  const m = formatCents;
  const flags = (r.review_flags ?? []).map((f) => t(`shifts.flag.${f}` as MessageKey));
  const overShortText = (c: number) =>
    c === 0
      ? t("shifts.balanced")
      : t(c > 0 ? "shifts.over" : "shifts.short", { amount: m(Math.abs(c)) });

  return (
    <article className="print-report flex max-w-3xl flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <Link href={`/o/${orgId}/shifts`} className="inline-flex min-h-12 items-center underline">
          {t("shifts.report.back")}
        </Link>
        <PrintButton />
      </div>
      <header className="flex flex-col gap-1">
        <h1 className="text-title font-semibold tracking-tight">
          {r.closed
            ? t("shifts.report.z", { number: `${till} · ${zNumber(r.z_seq as number)}` })
            : `${till} · ${t("shifts.report.x")}`}
        </h1>
        <p className="text-muted-foreground text-sm">
          {r.closed
            ? t("shifts.report.zNote", { time: time.format(new Date(r.closed_at as string)) })
            : t("shifts.report.xNote")}
        </p>
      </header>
      {flags.length > 0 && (
        <div
          role="note"
          className="border-warning bg-warning text-warning-foreground rounded-lg border-2 p-3 text-sm"
        >
          <p className="flex items-center gap-2 font-semibold">
            <TriangleAlertIcon aria-hidden className="size-5 shrink-0" />
            {t("shifts.report.checkTitle")}: {flags.join("; ")}
          </p>
          <p>{t("shifts.report.checkBody")}</p>
        </div>
      )}

      <section aria-labelledby="sales" className="surface-panel flex flex-col gap-3 p-5">
        <h2 id="sales" className="font-display text-heading font-semibold">
          {t("shifts.report.sales")}
        </h2>
        <Rows
          rows={[
            [t("shifts.report.count"), String(r.sales.count)],
            [t("shifts.report.total"), m(r.sales.amount_due_cents)],
            [t("shifts.report.vat"), m(r.sales.vat_cents)],
            [t("shifts.report.nonVat"), m(r.sales.non_vat_cents)],
            [t("shifts.report.discounts"), m(r.sales.discount_cents)],
            [t("shifts.report.rounding"), m(r.sales.rounding_cents)],
            [t("shifts.report.tips"), m(r.tips_cents)],
          ]}
        />
        <RateTable title={t("shifts.report.vatByRate")} rows={r.vat_by_rate} />
        <TenderTable
          title={t("shifts.report.tenders")}
          rows={r.tenders.map((x) => ({
            label: x.label,
            n: Number(x.payments),
            amount: Number(x.amount_cents),
            tip: Number(x.tip_cents),
          }))}
        />
      </section>

      <section aria-labelledby="refunds" className="surface-panel flex flex-col gap-3 p-5">
        <h2 id="refunds" className="font-display text-heading font-semibold">
          {t("shifts.report.refunds")}
        </h2>
        <Rows
          rows={[
            [t("shifts.report.count"), String(r.refunds.count)],
            [t("shifts.report.refundTotal"), m(r.refunds.amount_cents)],
            [t("shifts.report.credit"), m(r.refunds.credit_cents)],
          ]}
        />
        <RateTable title={t("shifts.report.refundVat")} rows={r.refund_vat_by_rate} />
        <TenderTable
          title={t("shifts.report.refundTenders")}
          rows={r.refund_tenders.map((x) => ({
            label: x.label,
            n: Number(x.refunds),
            amount: Number(x.amount_cents),
            tip: Number(x.tip_cents),
          }))}
        />
      </section>

      <section aria-labelledby="drawer" className="surface-panel flex flex-col gap-3 p-5">
        <h2 id="drawer" className="font-display text-heading font-semibold">
          {t("shifts.report.drawer")}
        </h2>
        <Rows
          rows={[
            [t("shifts.report.float"), m(r.drawer.float_cents)],
            [t("shifts.report.cashSales"), m(r.drawer.cash_sales_cents)],
            [t("shifts.report.cashIn"), m(r.drawer.cash_in_cents)],
            [t("shifts.report.cashOut"), "-" + m(r.drawer.cash_out_cents)],
            [t("shifts.report.cashRefunds"), "-" + m(r.drawer.cash_refunds_cents)],
            [t("shifts.report.expected"), m(r.drawer.expected_cents)],
            ...(r.closed
              ? ([
                  [t("shifts.report.counted"), m(r.counted_cents ?? 0)],
                  [t("shifts.report.overShort"), overShortText(r.over_short_cents ?? 0)],
                ] as [string, string][])
              : []),
          ]}
        />
      </section>
    </article>
  );
}
