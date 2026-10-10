import type { Metadata } from "next";
import Link from "next/link";
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
import { PAGE_SIZE } from "@/lib/catalog";
import { cleanCustomerSearch, listCustomers } from "@/lib/customers";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: `${t("customers.title")} · ${t("app.name")}` };

const pill = "border-border flex h-12 items-center rounded-full border px-5 text-sm font-medium";
const day = new Intl.DateTimeFormat("en-IE", { dateStyle: "medium", timeZone: "Europe/Dublin" });

export default async function CustomersPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ q?: string; page?: string }>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const sp = await searchParams;
  const q = cleanCustomerSearch(sp.q);
  const page = Math.max(1, Math.min(10_000, Number.parseInt(sp.page ?? "1", 10) || 1));
  const { rows, total } = await listCustomers(orgId, q, page);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (p: number) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return `/o/${orgId}/customers${s ? `?${s}` : ""}`;
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-semibold tracking-tight">{t("customers.title")}</h1>
        <Link href={`/o/${orgId}/customers/new`} className={buttonVariants({ size: "touch" })}>
          {t("customers.add")}
        </Link>
      </div>
      <p className="text-muted-foreground max-w-3xl text-sm">{t("customers.intro")}</p>

      <form method="get" role="search" className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-60 flex-1 flex-col gap-1.5">
          <label htmlFor="q" className="text-sm font-medium">
            {t("customers.search")}
          </label>
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={q}
            maxLength={60}
            autoComplete="off"
            className="border-input bg-background h-12 rounded-lg border px-3 text-base outline-none focus-visible:ring-3 md:text-sm"
          />
        </div>
        <Button type="submit" variant="outline" className="h-12 px-5">
          {t("customers.searchButton")}
        </Button>
      </form>

      {rows.length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="text-heading font-semibold">
            {q ? t("customers.noMatch") : t("customers.none")}
          </h2>
        </div>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("customers.title")}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("customers.col.name")}</TableHead>
                <TableHead scope="col">{t("customers.col.contact")}</TableHead>
                <TableHead scope="col">{t("customers.col.vat")}</TableHead>
                <TableHead scope="col">{t("customers.col.consent")}</TableHead>
                <TableHead scope="col">{t("customers.col.since")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableHead scope="row" className="font-medium">
                    <Link
                      href={`/o/${orgId}/customers/${r.id}`}
                      className="inline-flex min-h-12 items-center underline-offset-4 hover:underline"
                    >
                      {r.anonymised_at ? t("customers.anonymised") : r.name}
                    </Link>
                  </TableHead>
                  <TableCell>
                    {[r.email, r.phone].filter(Boolean).join(" · ") || t("customers.notGiven")}
                  </TableCell>
                  <TableCell className="font-mono">
                    {r.vat_number ?? t("customers.notGiven")}
                  </TableCell>
                  <TableCell>
                    {r.marketing_consent_at
                      ? t("customers.consent.yes", {
                          date: day.format(new Date(r.marketing_consent_at)),
                        })
                      : t("customers.consent.no")}
                  </TableCell>
                  <TableCell>{day.format(new Date(r.created_at))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {pages > 1 ? (
        <nav
          aria-label={t("catalog.pagination")}
          className="flex items-center justify-between gap-3"
        >
          {page > 1 ? (
            <Link href={link(page - 1)} className={pill}>
              {t("catalog.prev")}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground text-sm">
            {t("catalog.pageOf", { page, pages })}
          </span>
          {page < pages ? (
            <Link href={link(page + 1)} className={pill}>
              {t("catalog.next")}
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
    </section>
  );
}
