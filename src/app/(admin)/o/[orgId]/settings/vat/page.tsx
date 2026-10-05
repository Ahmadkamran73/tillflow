import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireRole } from "@/lib/auth";
import { getLocation, getTaxRates } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { findRateBp, localDate, TAX_CATEGORIES } from "@/lib/money";
import { getOrganisation } from "@/lib/org";
import { confirmVatRatesAction } from "@/lib/org-actions";

export const metadata: Metadata = { title: `${t("settings.vat")} · ${t("app.name")}` };

export default async function VatRatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  await requireRole("owner", orgId);
  const org = await getOrganisation(orgId);
  const location = await getLocation(orgId);
  if (!org || !location) notFound();
  const { result } = await searchParams;

  const rates = await getTaxRates();
  const today = localDate(new Date(), location.timezone);
  const rows = TAX_CATEGORIES.flatMap((code) => {
    try {
      return [{ code, bp: findRateBp(rates, "IE", code, today) }];
    } catch {
      return []; // no rate in force today: not shown, never guessed
    }
  });
  const confirmedOn = org.vatRatesConfirmedAt
    ? new Intl.DateTimeFormat("en-IE", {
        dateStyle: "long",
        timeZone: location.timezone,
      }).format(new Date(org.vatRatesConfirmedAt))
    : null;

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("settings.vat")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("vat.body")}</p>

      {result === "saved" ? (
        <p role="status" tabIndex={-1} autoFocus className="rounded-lg border p-3 text-sm">
          {t("vat.saved")}
        </p>
      ) : result ? (
        <p role="alert" tabIndex={-1} autoFocus className="text-destructive text-sm">
          {t("vat.error")}
        </p>
      ) : null}

      <div className="surface-panel overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("vat.col.rate")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("vat.col.percent")}
              </TableHead>
              <TableHead scope="col">{t("vat.col.use")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.code}>
                <TableCell className="font-medium">{t(`tax.${r.code}`)}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">{r.bp / 100}%</TableCell>
                <TableCell>{t(`vat.use.${r.code}`)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <p className="text-muted-foreground text-sm">{t("vat.rateNote")}</p>
      <p className="font-medium">
        {confirmedOn ? t("vat.confirmed", { date: confirmedOn }) : t("vat.notConfirmed")}
      </p>

      <form action={confirmVatRatesAction}>
        <input type="hidden" name="orgId" value={orgId} />
        <Button type="submit" className="h-12 px-5">
          {t("vat.confirm")}
        </Button>
      </form>
    </section>
  );
}
