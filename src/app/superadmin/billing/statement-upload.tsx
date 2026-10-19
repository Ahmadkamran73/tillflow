"use client";

import { AlertTriangleIcon, CheckCircle2Icon, CircleHelpIcon } from "lucide-react";
import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { invoiceNumber } from "@/lib/billing/invoice-number";
import { irishDate } from "@/lib/billing/period";
import {
  markInvoicePaidAction,
  matchStatementAction,
  type StatementState,
} from "@/lib/billing/admin-actions";
import { t, type MessageKey } from "@/lib/i18n";
import { formatCents } from "@/lib/money";

const idle: StatementState = { status: "idle" };

const KIND_TEXT: Record<string, MessageKey> = {
  exact: "admin.billing.match.exact",
  amountDiffers: "admin.billing.match.amountDiffers",
  paidAlready: "admin.billing.match.paidAlready",
  unknown: "admin.billing.match.unknown",
  badCheck: "admin.billing.match.badCheck",
};

/**
 * Upload a bank statement CSV; see which invoice each payment reference belongs to. Suggestions
 * only: every payment is confirmed by pressing its own button, which calls the same audited
 * "Mark as paid" as the list above.
 */
export function StatementUpload({ today }: { today: string }) {
  const [state, action, pending] = useActionState(matchStatementAction, idle);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="statement-heading">
      <h2 id="statement-heading" className="text-heading font-semibold">
        {t("admin.billing.statement")}
      </h2>
      <p className="text-muted-foreground max-w-prose text-sm">
        {t("admin.billing.statementIntro")}
      </p>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="statement">{t("admin.billing.statementFile")}</Label>
          <Input
            id="statement"
            name="statement"
            type="file"
            accept=".csv,text/csv"
            required
            aria-describedby="statement-hint"
            aria-invalid={state.status === "error" ? true : undefined}
            className="h-12"
          />
          <p id="statement-hint" className="text-muted-foreground text-xs">
            {t("admin.billing.statementHint")}
          </p>
        </div>
        <Button type="submit" className="h-12 px-5" disabled={pending}>
          {pending ? t("admin.billing.finding") : t("admin.billing.statementUpload")}
        </Button>
      </form>

      <div role="alert" className="text-destructive text-sm font-medium empty:hidden">
        {state.status === "error"
          ? t(
              state.reason === "limit"
                ? "admin.billing.statementLimit"
                : "admin.billing.statementBad",
            )
          : ""}
      </div>
      <div role="status" className="text-sm font-medium empty:hidden">
        {state.status === "done"
          ? state.suggestions.length === 0
            ? t("admin.billing.statementNone")
            : t("admin.billing.statementFound", { count: state.suggestions.length })
          : ""}
      </div>

      {state.status === "done" && state.suggestions.length > 0 ? (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("admin.billing.statement")}
        >
          <Table>
            <caption className="sr-only">{t("admin.billing.statement")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("admin.billing.match.line")}</TableHead>
                <TableHead scope="col">{t("admin.billing.match.date")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("admin.billing.match.amount")}
                </TableHead>
                <TableHead scope="col">{t("admin.billing.match.invoice")}</TableHead>
                <TableHead scope="col">{t("admin.billing.match.result")}</TableHead>
                <TableHead scope="col">{t("admin.billing.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.suggestions.map((s, i) => {
                const good = s.kind === "exact";
                const warn = s.kind === "amountDiffers" || s.kind === "badCheck";
                const Icon = good ? CheckCircle2Icon : warn ? AlertTriangleIcon : CircleHelpIcon;
                const invoice = "invoice" in s ? s.invoice : null;
                const confirmable = s.kind === "exact" || s.kind === "amountDiffers";
                return (
                  <TableRow key={`${s.line.row}-${i}`}>
                    <TableHead scope="row" className="max-w-72 font-normal break-words">
                      <span className="text-muted-foreground text-xs">#{s.line.row}</span>{" "}
                      {s.line.text}
                    </TableHead>
                    <TableCell>{s.line.date ? irishDate(s.line.date) : ""}</TableCell>
                    <TableCell className="text-right font-mono text-sm tabular-nums">
                      {s.line.amountsCents.map((c) => formatCents(c)).join(", ")}
                    </TableCell>
                    <TableCell>
                      {invoice ? (
                        <>
                          <span className="font-mono">{invoiceNumber(invoice.invoice_no)}</span>
                          <span className="block text-sm">{invoice.org_name}</span>
                          <span className="block font-mono text-sm tabular-nums">
                            {formatCents(invoice.total_cents)}
                          </span>
                        </>
                      ) : (
                        <span className="font-mono text-sm">
                          {"reference" in s ? s.reference : ""}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-start gap-2">
                        <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
                        {t(KIND_TEXT[s.kind]!)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {confirmable && invoice ? (
                        <details>
                          <summary className="inline-flex min-h-12 cursor-pointer items-center font-medium underline">
                            {t("admin.billing.match.review")}
                            <span className="sr-only"> {invoiceNumber(invoice.invoice_no)}</span>
                          </summary>
                          <form action={markInvoicePaidAction} className="mt-2 flex flex-col gap-2">
                            <input type="hidden" name="invoiceId" value={invoice.invoice_id} />
                            <input type="hidden" name="filter" value="outstanding" />
                            <Label htmlFor={`bank-${i}`}>{t("admin.billing.bankReference")}</Label>
                            <Input
                              id={`bank-${i}`}
                              name="bankReference"
                              defaultValue={invoice.reference}
                              required
                              minLength={3}
                              maxLength={100}
                              className="h-12"
                            />
                            <Label htmlFor={`paid-${i}`}>{t("admin.billing.paidOn")}</Label>
                            <Input
                              id={`paid-${i}`}
                              name="paidOn"
                              type="date"
                              defaultValue={s.line.date ?? today}
                              max={today}
                              required
                              className="h-12"
                            />
                            <Button type="submit" className="h-12 px-5">
                              {t("admin.billing.confirmPaid")}
                              <span className="sr-only"> {invoiceNumber(invoice.invoice_no)}</span>
                            </Button>
                          </form>
                        </details>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </section>
  );
}
