import Link from "next/link";
import { z } from "zod";
import { FocusMessage } from "@/components/back-office/focus-message";
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
import { createSupabaseServerClient, requireSuperadmin } from "@/lib/auth";
import { markInvoicePaidAction, unpauseOrganisationAction } from "@/lib/billing/admin-actions";
import { loadBillingConfig } from "@/lib/billing/config";
import { invoiceNumber } from "@/lib/billing/invoice-number";
import { dublinDate, irishDate } from "@/lib/billing/period";
import { t, type MessageKey } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { StatementUpload } from "./statement-upload";

export const dynamic = "force-dynamic";

const FILTERS = ["outstanding", "overdue", "paid"] as const;
const filterSchema = z.enum(FILTERS).catch("outstanding");

const row = z.object({
  id: z.uuid(),
  org_id: z.uuid(),
  org_name: z.string(),
  org_status: z.string(),
  invoice_no: z.number().int(),
  total_cents: z.number().int(),
  due_on: z.string(),
  payment_reference: z.string(),
  status: z.string(),
  paid_on: z.string().nullable(),
  bank_reference: z.string().nullable(),
});

const RESULTS: Record<string, { key: MessageKey; ok: boolean }> = {
  paid: { key: "admin.billing.done.paid", ok: true },
  unpaused: { key: "admin.billing.done.unpaused", ok: true },
  error: { key: "admin.billing.error", ok: false },
};

/** Super-admin only (two-step session + platform_admins): every business's invoices. */
export default async function AdminBillingPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; result?: string }>;
}) {
  await requireSuperadmin("/superadmin/billing");
  const sp = await searchParams;
  const filter = filterSchema.parse(sp.filter);
  const result = sp.result ? RESULTS[sp.result] : undefined;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("admin_list_invoices", { p_filter: filter });
  if (error) throw new Error("Could not load invoices");
  const rows = z.array(row).parse(data ?? []);
  const today = dublinDate(new Date());
  const config = loadBillingConfig();
  const holdDefault = config.ok ? config.config.graceDays : 7;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-title font-semibold tracking-tight">{t("admin.billing.title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("admin.billing.intro")}</p>
      </div>

      <FocusMessage message={result ? t(result.key) : ""} urgent={!!result && !result.ok} />

      <nav aria-label={t("admin.billing.filter")}>
        <ul className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <li key={f}>
              <Link
                href={`/superadmin/billing?filter=${f}`}
                aria-current={f === filter ? "page" : undefined}
                className={`inline-flex min-h-12 items-center rounded-full border-2 px-4 text-sm font-medium ${
                  f === filter ? "border-ember bg-muted" : "border-border"
                }`}
              >
                {f === filter ? <span aria-hidden>✓ </span> : null}
                {t(`admin.billing.filter.${f}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("admin.billing.empty")}</p>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t(`admin.billing.filter.${filter}`)}
        >
          <Table>
            <caption className="sr-only">{t(`admin.billing.filter.${filter}`)}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("admin.billing.col.business")}</TableHead>
                <TableHead scope="col">{t("admin.billing.col.number")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("admin.billing.col.total")}
                </TableHead>
                <TableHead scope="col">{t("admin.billing.col.due")}</TableHead>
                <TableHead scope="col">{t("admin.billing.col.reference")}</TableHead>
                <TableHead scope="col">
                  {filter === "paid" ? t("admin.billing.col.paid") : t("admin.billing.col.account")}
                </TableHead>
                <TableHead scope="col">{t("admin.billing.col.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const paused = r.org_status === "read_only";
                const label = invoiceNumber(r.invoice_no);
                return (
                  <TableRow key={r.id}>
                    <TableHead scope="row" className="font-normal">
                      {r.org_name}
                    </TableHead>
                    <TableCell className="font-mono">{label}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCents(r.total_cents)}
                    </TableCell>
                    <TableCell>{irishDate(r.due_on)}</TableCell>
                    <TableCell className="font-mono text-sm">{r.payment_reference}</TableCell>
                    <TableCell>
                      {filter === "paid" ? (
                        <>
                          {r.paid_on ? irishDate(r.paid_on) : ""}
                          <span className="text-muted-foreground block text-xs break-all">
                            {r.bank_reference}
                          </span>
                        </>
                      ) : paused ? (
                        t("admin.billing.account.paused")
                      ) : (
                        t("admin.billing.account.ok")
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-col gap-2">
                        {r.status === "issued" ? (
                          <details>
                            <summary className="inline-flex min-h-12 cursor-pointer items-center font-medium underline">
                              {t("admin.billing.markPaid")}
                              <span className="sr-only">
                                {" "}
                                {label}, {r.org_name}
                              </span>
                            </summary>
                            <form
                              action={markInvoicePaidAction}
                              className="mt-2 flex max-w-xs flex-col gap-2"
                            >
                              <input type="hidden" name="invoiceId" value={r.id} />
                              <input type="hidden" name="filter" value={filter} />
                              <Label htmlFor={`bank-${r.id}`}>
                                {t("admin.billing.bankReference")}
                              </Label>
                              <Input
                                id={`bank-${r.id}`}
                                name="bankReference"
                                required
                                minLength={3}
                                maxLength={100}
                                aria-describedby={`bank-${r.id}-hint`}
                                className="h-12"
                              />
                              <p id={`bank-${r.id}-hint`} className="text-muted-foreground text-xs">
                                {t("admin.billing.bankReferenceHint")}
                              </p>
                              <Label htmlFor={`paid-${r.id}`}>{t("admin.billing.paidOn")}</Label>
                              <Input
                                id={`paid-${r.id}`}
                                name="paidOn"
                                type="date"
                                defaultValue={today}
                                max={today}
                                required
                                className="h-12"
                              />
                              <Button type="submit" className="h-12 px-5">
                                {t("admin.billing.confirmPaid")}
                              </Button>
                            </form>
                          </details>
                        ) : null}
                        {paused ? (
                          <details>
                            <summary className="inline-flex min-h-12 cursor-pointer items-center font-medium underline">
                              {t("admin.billing.unpause")}
                              <span className="sr-only">
                                {" "}
                                {r.org_name}
                              </span>
                            </summary>
                            <form
                              action={unpauseOrganisationAction}
                              className="mt-2 flex max-w-xs flex-col gap-2"
                            >
                              <input type="hidden" name="orgId" value={r.org_id} />
                              <input type="hidden" name="filter" value={filter} />
                              <Label htmlFor={`note-${r.id}`}>{t("admin.billing.note")}</Label>
                              <Input
                                id={`note-${r.id}`}
                                name="note"
                                required
                                minLength={5}
                                maxLength={300}
                                aria-describedby={`note-${r.id}-hint`}
                                className="h-12"
                              />
                              <p id={`note-${r.id}-hint`} className="text-muted-foreground text-xs">
                                {t("admin.billing.noteHint")}
                              </p>
                              <Label htmlFor={`hold-${r.id}`}>{t("admin.billing.holdDays")}</Label>
                              <Input
                                id={`hold-${r.id}`}
                                name="holdDays"
                                type="number"
                                min={0}
                                max={365}
                                defaultValue={holdDefault}
                                required
                                aria-describedby={`hold-${r.id}-hint`}
                                className="h-12"
                              />
                              <p id={`hold-${r.id}-hint`} className="text-muted-foreground text-xs">
                                {t("admin.billing.holdHint")}
                              </p>
                              <Button type="submit" variant="outline" className="h-12 px-5">
                                {t("admin.billing.confirmUnpause")}
                              </Button>
                            </form>
                          </details>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <StatementUpload today={today} />
    </div>
  );
}
