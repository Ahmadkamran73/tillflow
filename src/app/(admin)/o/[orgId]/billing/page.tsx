import type { Metadata } from "next";
import { CopyButton } from "@/components/back-office/copy-button";
import { FocusMessage } from "@/components/back-office/focus-message";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireRole } from "@/lib/auth";
import { formatIban, loadBillingConfig } from "@/lib/billing/config";
import { invoiceNumber } from "@/lib/billing/invoice-number";
import { getBillingOverview } from "@/lib/billing/owner";
import { addDays, dublinDate, irishDate } from "@/lib/billing/period";
import { t } from "@/lib/i18n";
import { centsToInput, formatCents } from "@/lib/money";

export const metadata: Metadata = { title: `${t("billing.title")} · ${t("app.name")}` };
export const dynamic = "force-dynamic";

const messages: Record<string, string> = {
  failed: "billing.downloadFailed",
  limit: "billing.downloadLimit",
};

/** The owner's billing page: status, what to pay and how, and every invoice with its PDF. */
export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ download?: string }>;
}) {
  const { orgId } = await params;
  await requireRole("owner", orgId);
  const { download } = await searchParams;
  const [overview, configResult] = await Promise.all([
    getBillingOverview(orgId),
    Promise.resolve(loadBillingConfig()),
  ]);
  const today = dublinDate(new Date());
  const out = overview.outstanding;
  const status = overview.status ?? "trial";

  const stateLine = (() => {
    if (status === "paused") {
      return out
        ? t("billing.stateLine.paused", { number: invoiceNumber(out.invoice_no) })
        : t("billing.stateLine.pausedNoInvoice");
    }
    if (out && out.due_on < today) {
      return t("billing.stateLine.overdue", {
        number: invoiceNumber(out.invoice_no),
        date: irishDate(out.due_on),
      });
    }
    if (status === "active" && overview.paidThrough) {
      return t("billing.stateLine.active", { date: irishDate(addDays(overview.paidThrough, -1)) });
    }
    if (status === "active") return t("billing.stateLine.activeNoDate");
    return overview.trialEndsOn
      ? t("billing.stateLine.trial", { date: irishDate(overview.trialEndsOn) })
      : t("billing.stateLine.trialNoDate");
  })();

  const nextInvoice = (() => {
    if (out) return t("billing.nextInvoiceWhenPaid");
    if (status === "active" && overview.paidThrough) return irishDate(overview.paidThrough);
    if (overview.trialEndsOn && overview.invoices.length === 0) {
      return t("billing.nextInvoiceAtTrialEnd", { date: irishDate(overview.trialEndsOn) });
    }
    return t("billing.nextInvoiceUnknown");
  })();

  const shownStatus = out && status !== "paused" && out.due_on < today ? "overdue" : status;
  const message =
    download && messages[download] ? t(messages[download] as "billing.downloadFailed") : "";

  return (
    <section className="flex max-w-4xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-title font-semibold tracking-tight">{t("billing.title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("billing.intro")}</p>
      </div>

      <FocusMessage message={message} urgent />

      <div className="surface-panel flex flex-col gap-3 p-4">
        <h2 className="text-heading font-semibold">{t("billing.status")}</h2>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">{t("billing.status")}</dt>
          <dd className="font-medium">{t(`billing.state.${shownStatus}`)}</dd>
          <dt className="text-muted-foreground">{t("billing.nextInvoice")}</dt>
          <dd className="font-medium">{nextInvoice}</dd>
        </dl>
        <p className="max-w-prose text-sm">{stateLine}</p>
      </div>

      <div className="surface-panel flex flex-col gap-3 p-4">
        <h2 className="text-heading font-semibold">{t("billing.pay")}</h2>
        <p className="text-muted-foreground max-w-prose text-sm">{t("billing.payIntro")}</p>
        {out ? (
          <p className="text-sm font-medium">
            {t("billing.payOutstanding", {
              number: invoiceNumber(out.invoice_no),
              amount: formatCents(out.total_cents),
              date: irishDate(out.due_on),
            })}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">{t("billing.noOutstanding")}</p>
        )}
        {configResult.ok ? (
          <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t("billing.account")}</dt>
            <dd className="font-medium">{configResult.config.accountName}</dd>
            <dt className="text-muted-foreground">{t("billing.iban")}</dt>
            <dd className="flex flex-wrap items-center gap-3">
              <span className="font-mono font-medium">{formatIban(configResult.config.iban)}</span>
              <CopyButton value={configResult.config.iban} what={t("billing.iban")} />
            </dd>
            <dt className="text-muted-foreground">{t("billing.bic")}</dt>
            <dd className="flex flex-wrap items-center gap-3">
              <span className="font-mono font-medium">{configResult.config.bic}</span>
              <CopyButton value={configResult.config.bic} what={t("billing.bic")} />
            </dd>
            {out ? (
              <>
                <dt className="text-muted-foreground">{t("billing.amount")}</dt>
                <dd className="flex flex-wrap items-center gap-3">
                  <span className="font-mono font-medium tabular-nums">
                    {formatCents(out.total_cents)}
                  </span>
                  <CopyButton
                    value={centsToInput(out.total_cents)}
                    what={t("billing.amount")}
                  />
                </dd>
                <dt className="text-muted-foreground">{t("billing.reference")}</dt>
                <dd className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-base font-semibold">{out.payment_reference}</span>
                  <CopyButton value={out.payment_reference} what={t("billing.reference")} />
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="text-sm font-medium">{t("billing.notConfigured")}</p>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t("billing.history")}</h2>
        {overview.invoices.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("billing.none")}</p>
        ) : (
          <div
            className="surface-panel overflow-x-auto"
            role="region"
            tabIndex={0}
            aria-label={t("billing.history")}
          >
            <Table>
              <caption className="sr-only">{t("billing.history")}</caption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("billing.col.number")}</TableHead>
                  <TableHead scope="col">{t("billing.col.period")}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("billing.col.total")}
                  </TableHead>
                  <TableHead scope="col">{t("billing.col.due")}</TableHead>
                  <TableHead scope="col">{t("billing.col.status")}</TableHead>
                  <TableHead scope="col">{t("billing.col.pdf")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overview.invoices.map((inv) => {
                  const late = inv.status === "issued" && inv.due_on < today;
                  const label = invoiceNumber(inv.invoice_no);
                  return (
                    <TableRow key={inv.id}>
                      <TableHead scope="row" className="font-mono font-medium">
                        {label}
                      </TableHead>
                      <TableCell>
                        {irishDate(inv.period_start)} - {irishDate(addDays(inv.period_end, -1))}
                      </TableCell>
                      <TableCell className="text-right font-mono tabular-nums">
                        {formatCents(inv.total_cents)}
                      </TableCell>
                      <TableCell>{irishDate(inv.due_on)}</TableCell>
                      <TableCell>
                        {inv.status === "paid"
                          ? t("billing.invoiceStatus.paid", {
                              date: inv.paid_on ? irishDate(inv.paid_on) : "",
                            })
                          : late
                            ? t("billing.invoiceStatus.overdue")
                            : t(`billing.invoiceStatus.${inv.status}`)}
                      </TableCell>
                      <TableCell>
                        <a
                          href={`/o/${orgId}/billing/invoices/${inv.id}/pdf`}
                          download
                          className="inline-flex min-h-12 items-center font-medium underline"
                        >
                          {t("billing.download")}
                          <span className="sr-only"> {label}</span>
                        </a>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </section>
  );
}
