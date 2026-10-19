import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireRole } from "@/lib/auth";
import { anonymiseCustomerAction, setConsentAction } from "@/lib/customer-actions";
import { customerPurchases, getCustomer } from "@/lib/customers";
import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { CustomerForm } from "../customer-form";
import { FocusMessage } from "./focus-message";

export const metadata: Metadata = { title: `${t("customers.edit.title")} · ${t("app.name")}` };

const when = new Intl.DateTimeFormat("en-IE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Dublin",
});

export default async function CustomerPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; customerId: string }>;
  searchParams: Promise<{ saved?: string; erased?: string; error?: string; limit?: string }>;
}) {
  const { orgId, customerId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const customer = await getCustomer(orgId, customerId);
  if (!customer) notFound();
  const sp = await searchParams;
  const purchases = await customerPurchases(orgId, customerId);
  const gone = customer.anonymised_at !== null;
  const exportBase = `/o/${orgId}/customers/${customerId}/export`;
  const message = sp.erased
    ? t("customers.gdpr.done")
    : sp.saved
      ? t("customers.saved")
      : sp.limit
        ? t("customers.gdpr.limit")
        : sp.error
          ? t("customers.err.generic")
          : "";

  return (
    <section className="flex flex-col gap-6">
      <h1 className="text-title font-semibold tracking-tight">
        {gone ? t("customers.anonymised") : customer.name}
      </h1>
      <FocusMessage message={message} urgent={!!(sp.error || sp.limit)} />

      {gone ? null : (
        <>
          <CustomerForm
            orgId={orgId}
            customerId={customerId}
            initial={{
              name: customer.name,
              email: customer.email ?? "",
              phone: customer.phone ?? "",
              vatNumber: customer.vat_number ?? "",
              address: customer.address ?? "",
              notes: customer.notes ?? "",
            }}
          />

          <div className="surface-panel flex max-w-xl flex-col gap-3 p-5">
            <h2 className="text-heading font-semibold">{t("customers.consent.title")}</h2>
            <p className="text-muted-foreground text-sm">{t("customers.consent.note")}</p>
            <p className="text-sm">
              {customer.marketing_consent_at
                ? t("customers.consent.yes", {
                    date: when.format(new Date(customer.marketing_consent_at)),
                  })
                : t("customers.consent.no")}
            </p>
            <form action={setConsentAction}>
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="customerId" value={customerId} />
              <input type="hidden" name="on" value={customer.marketing_consent_at ? "0" : "1"} />
              <Button type="submit" variant="outline" className="h-12 px-5">
                {customer.marketing_consent_at
                  ? t("customers.consent.withdraw")
                  : t("customers.consent.give")}
              </Button>
            </form>
          </div>
        </>
      )}

      <div className="flex flex-col gap-3">
        <h2 className="text-heading font-semibold">{t("customers.history.title")}</h2>
        {purchases.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("customers.history.none")}</p>
        ) : (
          <div
            className="surface-panel overflow-x-auto"
            role="region"
            tabIndex={0}
            aria-label={t("customers.history.title")}
          >
            <Table aria-label={t("customers.history.title")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t("customers.history.col.receipt")}</TableHead>
                  <TableHead scope="col">{t("customers.history.col.date")}</TableHead>
                  <TableHead scope="col" className="text-right">
                    {t("customers.history.col.total")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {purchases.map((s) => (
                  <TableRow key={s.id}>
                    <TableHead scope="row" className="font-mono">
                      {String(s.receipt_seq).padStart(6, "0")}
                    </TableHead>
                    <TableCell>{when.format(new Date(s.completed_at))}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {formatCents(s.amount_due_cents)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>

      <div className="surface-panel flex max-w-xl flex-col gap-3 p-5">
        <h2 className="text-heading font-semibold">{t("customers.gdpr.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("customers.gdpr.intro")}</p>
        <div className="flex flex-wrap gap-3">
          <a
            href={`${exportBase}?format=json`}
            className={buttonVariants({ variant: "outline", size: "touch" })}
          >
            {t("customers.gdpr.exportJson")}
          </a>
          <a
            href={`${exportBase}?format=csv`}
            className={buttonVariants({ variant: "outline", size: "touch" })}
          >
            {t("customers.gdpr.exportCsv")}
          </a>
        </div>
        {gone ? null : (
          <details className="mt-2">
            <summary className="flex min-h-12 cursor-pointer items-center text-sm font-medium underline-offset-4 hover:underline">
              {t("customers.gdpr.anonymise")}
            </summary>
            <form action={anonymiseCustomerAction} className="mt-2 flex flex-col gap-3">
              <input type="hidden" name="orgId" value={orgId} />
              <input type="hidden" name="customerId" value={customerId} />
              <p className="text-sm">{t("customers.gdpr.confirm")}</p>
              <Button type="submit" variant="destructive" className="h-12 self-start px-5">
                {t("customers.gdpr.confirmButton")}
              </Button>
            </form>
          </details>
        )}
      </div>
    </section>
  );
}
