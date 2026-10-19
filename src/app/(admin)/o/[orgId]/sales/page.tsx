import type { ReviewFlag } from "@/lib/sync/process";
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
import { t } from "@/lib/i18n";
import { startOfLocalDay } from "@/lib/local-day";
import { getSalesToReview } from "@/lib/sync/attention";
import { formatCents } from "@/lib/money";
import { receiptNo } from "@/lib/register/sale";

export const metadata: Metadata = { title: `${t("sales.title")} · ${t("app.name")}` };

/** The latest sales that have reached the server (reports come later), and a link to Needs attention. */
export default async function SalesPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const location = await getLocation(orgId);
  if (!location) notFound();

  const supabase = await createSupabaseServerClient();
  const [sales, registers, attention, toReview] = await Promise.all([
    supabase
      .from("sales")
      .select(
        "id, register_id, receipt_seq, completed_at, vat_cents, amount_due_cents, review_flags",
      )
      .eq("org_id", orgId)
      .order("completed_at", { ascending: false })
      .limit(50),
    supabase.from("registers").select("id, name").eq("org_id", orgId),
    supabase
      .from("sync_rejections")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId)
      .eq("status", "open"),
    getSalesToReview(orgId),
  ]);
  if (sales.error || registers.error) throw new Error("Could not load sales");
  const tills = new Map((registers.data ?? []).map((r) => [r.id as string, r.name as string]));
  const time = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: location.timezone,
  });
  const open = attention.count ?? 0;

  // Refunds are separate records; the sale they refund is never changed.
  const refundRows = await supabase
    .from("refunds")
    .select(
      "id, register_id, original_sale_id, kind, reason_code, receipt_seq, completed_at, amount_cents, credit_cents, approval_state, cashier_user_id",
    )
    .eq("org_id", orgId)
    .order("completed_at", { ascending: false })
    .limit(50);
  if (refundRows.error) throw new Error("Could not load refunds");
  const refundList = refundRows.data ?? [];
  // Who rang each refund, by the name they use on the till (the till names its cashier).
  const staff = await supabase
    .from("memberships")
    .select("user_id, display_name")
    .eq("org_id", orgId);
  const cashierName = new Map(
    (staff.data ?? []).map((m) => [m.user_id as string, (m.display_name as string | null) ?? "-"]),
  );
  const originalIds = [...new Set(refundList.map((r) => r.original_sale_id as string))];
  const originals = originalIds.length
    ? await supabase
        .from("sales")
        .select("id, register_id, receipt_seq")
        .eq("org_id", orgId)
        .in("id", originalIds)
    : { data: [], error: null };
  if (originals.error) throw new Error("Could not load refunds");
  const originalNo = new Map(
    (originals.data ?? []).map((s) => [
      s.id as string,
      receiptNo(tills.get(s.register_id as string) ?? "Till", s.receipt_seq as number),
    ]),
  );

  // Z-report groundwork: today's payments per type, so the card total can be compared with the
  // card terminal's end-of-day report. RLS applies (managers and owners only).
  const dayStart = startOfLocalDay(new Date(), location.timezone);
  const dayEnd = new Date(dayStart.getTime() + 25 * 3_600_000); // covers a 25-hour day; later sales are not yet made
  const totals = await supabase.rpc("tender_totals", {
    p_org: orgId,
    p_from: dayStart.toISOString(),
    p_to: dayEnd.toISOString(),
  });
  if (totals.error) throw new Error("Could not load payment totals");
  const refundTotals = await supabase.rpc("refund_totals", {
    p_org: orgId,
    p_from: dayStart.toISOString(),
    p_to: dayEnd.toISOString(),
  });
  if (refundTotals.error) throw new Error("Could not load refund totals");
  const refundsByTender = (refundTotals.data ?? []) as {
    method: string;
    label: string;
    refunds: number;
    amount_cents: number;
    tip_cents: number;
  }[];
  const byTender = (totals.data ?? []) as {
    method: string;
    label: string;
    payments: number;
    amount_cents: number;
    tip_cents: number;
  }[];

  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("sales.title")}</h1>
      <p>
        <Link href={`/o/${orgId}/sales/attention`} className="font-medium underline">
          {open > 0 ? t("sales.attentionLink", { count: open }) : t("sales.attentionNone")}
        </Link>
      </p>
      {toReview.length > 0 && (
        <p>
          <Link
            href={`/o/${orgId}/sales/review`}
            className="inline-flex min-h-12 items-center font-medium underline"
          >
            {t("sales.reviewLink", { count: toReview.length })}
          </Link>
        </p>
      )}
      <section aria-labelledby="by-tender" className="surface-panel flex flex-col gap-3 p-5">
        <h2 id="by-tender" className="font-display text-heading font-semibold">
          {t("sales.byTender")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("sales.byTenderNote")}</p>
        {byTender.length === 0 ? (
          <p className="text-sm">{t("sales.byTenderNone")}</p>
        ) : (
          <div
            className="overflow-x-auto"
            role="region"
            tabIndex={0}
            aria-label={t("sales.byTender")}
          >
            <Table>
              <caption className="sr-only">{t("sales.byTender")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("sales.tender.type")}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("sales.tender.count")}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("sales.tender.amount")}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("sales.tender.tips")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byTender.map((r) => (
                  <TableRow key={`${r.method}-${r.label}`}>
                    <TableCell>{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(r.payments)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCents(Number(r.amount_cents))}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCents(Number(r.tip_cents))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <section aria-labelledby="refunds-today" className="surface-panel flex flex-col gap-3 p-5">
        <h2 id="refunds-today" className="font-display text-heading font-semibold">
          {t("sales.refundsByTender")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("sales.refundsByTenderNote")}</p>
        {refundsByTender.length === 0 ? (
          <p className="text-sm">{t("sales.refundsByTenderNone")}</p>
        ) : (
          <div
            className="overflow-x-auto"
            role="region"
            tabIndex={0}
            aria-label={t("sales.refundsByTender")}
          >
            <Table>
              <caption className="sr-only">{t("sales.refundsByTender")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("sales.tender.type")}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("sales.tender.count")}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("sales.refund.amount")}
                  </TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("sales.tender.tips")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refundsByTender.map((r) => (
                  <TableRow key={`${r.method}-${r.label}`}>
                    <TableCell>{r.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{Number(r.refunds)}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCents(Number(r.amount_cents))}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCents(Number(r.tip_cents))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      <section aria-labelledby="refunds-list" className="surface-panel flex flex-col gap-3 p-5">
        <h2 id="refunds-list" className="font-display text-heading font-semibold">
          {t("sales.refunds")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("sales.refundsNote")}</p>
        {refundList.length === 0 ? (
          <p className="text-sm">{t("sales.refundsNone")}</p>
        ) : (
          <div
            className="overflow-x-auto"
            role="region"
            tabIndex={0}
            aria-label={t("sales.refunds")}
          >
            <Table>
              <caption className="sr-only">{t("sales.refunds")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("sales.refund.number")}</TableHead>
                  <TableHead scope="col">{t("sales.refund.when")}</TableHead>
                  <TableHead scope="col">{t("sales.refund.kind")}</TableHead>
                  <TableHead scope="col">{t("sales.refund.cashier")}</TableHead>
                  <TableHead scope="col">{t("sales.refund.original")}</TableHead>
                  <TableHead scope="col">{t("sales.refund.reason")}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("sales.refund.amount")}
                  </TableHead>
                  <TableHead scope="col">{t("sales.refund.approved")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refundList.map((r) => (
                  <TableRow key={r.id as string}>
                    <TableHead scope="row" className="font-mono font-normal">
                      {(tills.get(r.register_id as string) ?? "Till") +
                        " · R" +
                        String(r.receipt_seq as number).padStart(6, "0")}
                    </TableHead>
                    <TableCell>{time.format(new Date(r.completed_at as string))}</TableCell>
                    <TableCell>{t(`refund.kind.${r.kind as "refund" | "void" | "exchange"}`)}</TableCell>
                    <TableCell>{cashierName.get(r.cashier_user_id as string) ?? "-"}</TableCell>
                    <TableCell className="font-mono">
                      {originalNo.get(r.original_sale_id as string) ?? "-"}
                    </TableCell>
                    <TableCell>
                      {t(
                        `refund.reason.${
                          r.reason_code as
                            | "changed_mind"
                            | "faulty"
                            | "wrong_item"
                            | "damaged"
                            | "void_mistake"
                            | "other"
                        }`,
                      )}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCents(r.amount_cents as number)}
                      {(r.credit_cents as number) > 0 && (
                        <span className="text-muted-foreground block text-xs">
                          {t("sales.refundRow.credit")} {formatCents(r.credit_cents as number)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.approval_state === "verified" ? (
                        t("sales.refund.verified")
                      ) : r.approval_state === "unverified" || r.approval_state === "self" ? (
                        <span className="flex items-start gap-1 font-semibold">
                          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                          {t(
                            r.approval_state === "self"
                              ? "sales.refund.self"
                              : "sales.refund.unverified",
                          )}
                        </span>
                      ) : (
                        t("sales.refund.none")
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
      {(sales.data ?? []).length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="font-display text-heading font-semibold">{t("sales.empty")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("sales.emptyBody")}</p>
        </div>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("sales.title")}
        >
          <Table>
            <caption className="sr-only">{t("sales.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("sales.col.receipt")}</TableHead>
                <TableHead scope="col">{t("sales.col.time")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("sales.col.vat")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("sales.col.total")}
                </TableHead>
                <TableHead scope="col">{t("sales.col.check")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(sales.data ?? []).map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-mono">
                    {receiptNo(
                      tills.get(s.register_id as string) ?? "Till",
                      s.receipt_seq as number,
                    )}
                  </TableCell>
                  <TableCell>{time.format(new Date(s.completed_at as string))}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(s.vat_cents as number)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(s.amount_due_cents as number)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {((s.review_flags as string[] | null) ?? []).length > 0 ? (
                      <Link href={`/o/${orgId}/sales/review`} className="underline">
                        {(s.review_flags as string[])
                          .map((f) => t(`sales.flag.${f as ReviewFlag}`))
                          .join("; ")}
                      </Link>
                    ) : (
                      t("sales.flag.none")
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
