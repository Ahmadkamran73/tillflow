import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangleIcon } from "lucide-react";
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
import { cleanSearch, getLocation, PAGE_SIZE } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { FILTERS, listStock, type StockFilter } from "@/lib/inventory";
import { formatCents } from "@/lib/money";

export const metadata: Metadata = { title: `${t("inventory.title")} · ${t("app.name")}` };

type Search = { q?: string; filter?: string; page?: string };

const pill = "border-border flex h-12 items-center rounded-full border px-5 text-sm font-medium";

export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Search>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const location = await getLocation(orgId);
  if (!location) notFound();
  const sp = await searchParams;
  const q = cleanSearch(sp.q);
  const filter: StockFilter = (FILTERS as readonly string[]).includes(sp.filter ?? "")
    ? (sp.filter as StockFilter)
    : "all";
  const page = Math.max(1, Math.min(10_000, Number.parseInt(sp.page ?? "1", 10) || 1));

  const { rows, total, value } = await listStock(orgId, location.id, { q, filter, page });
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const link = (f: StockFilter, p = 1) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (f !== "all") qs.set("filter", f);
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return `/o/${orgId}/inventory${s ? `?${s}` : ""}`;
  };

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("inventory.title")}</h1>
      <p className="text-muted-foreground max-w-3xl text-sm">{t("inventory.intro")}</p>

      <div className="surface-panel flex flex-col gap-1 p-5">
        <p className="text-muted-foreground font-mono text-xs tracking-wide">
          {t("inventory.valueLabel")}
        </p>
        <p className="text-amount font-mono tabular-nums" data-testid="stock-value">
          {formatCents(value.totalCents)}
        </p>
        <p className="text-muted-foreground text-sm">{t("inventory.valueNote")}</p>
        {value.unvalued > 0 ? (
          <p className="text-sm">{t("inventory.unvalued", { n: value.unvalued })}</p>
        ) : null}
        {value.negative > 0 ? (
          <p className="text-sm">{t("inventory.negativeCount", { n: value.negative })}</p>
        ) : null}
      </div>

      <form method="get" role="search" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="filter" value={filter === "all" ? "" : filter} />
        <div className="flex min-w-60 flex-1 flex-col gap-1.5">
          <label htmlFor="q" className="text-sm font-medium">
            {t("inventory.search")}
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
          {t("inventory.searchButton")}
        </Button>
      </form>

      <nav aria-label={t("inventory.filter.label")} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={link(f)}
            aria-current={f === filter ? "page" : undefined}
            className={`${pill} ${f === filter ? "bg-primary text-primary-foreground" : ""}`}
          >
            {f === filter ? "✓ " : ""}
            {t(`inventory.filter.${f}`)}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="text-heading font-semibold">{t("inventory.empty")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("inventory.emptyBody")}</p>
        </div>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("inventory.listLabel")}
        >
          <Table aria-label={t("inventory.listLabel")}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("inventory.col.item")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("inventory.col.onHand")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("inventory.col.threshold")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("inventory.col.cost")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("inventory.col.value")}
                </TableHead>
                <TableHead scope="col">{t("inventory.col.status")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const bad = r.onHand < 0 || r.status === "negative";
                return (
                  <TableRow key={r.variantId} className={bad ? "bg-destructive/10" : undefined}>
                    <TableHead scope="row" className="font-medium">
                      <Link
                        href={`/o/${orgId}/inventory/${r.variantId}`}
                        className="inline-flex min-h-12 items-center underline-offset-4 hover:underline"
                      >
                        {r.name}
                      </Link>
                    </TableHead>
                    <TableCell className="text-right font-mono tabular-nums">{r.onHand}</TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {r.threshold ?? t("inventory.noThreshold")}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {r.costCents === null ? t("inventory.noCost") : formatCents(r.costCents)}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {r.valueCents === null ? t("inventory.noValue") : formatCents(r.valueCents)}
                    </TableCell>
                    <TableCell>
                      <span
                        className="inline-flex items-center gap-1.5"
                        data-status={bad ? "negative" : r.status}
                      >
                        {bad || r.status === "out" || r.status === "low" ? (
                          <AlertTriangleIcon aria-hidden className="size-4" />
                        ) : null}
                        {t(`inventory.status.${bad ? "negative" : r.status}`)}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
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
            <Link href={link(filter, page - 1)} className={pill}>
              {t("catalog.prev")}
            </Link>
          ) : (
            <span />
          )}
          <span className="text-muted-foreground text-sm">
            {t("catalog.pageOf", { page, pages })}
          </span>
          {page < pages ? (
            <Link href={link(filter, page + 1)} className={pill}>
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
