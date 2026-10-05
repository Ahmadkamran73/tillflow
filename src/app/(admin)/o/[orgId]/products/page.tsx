import type { Metadata } from "next";
import Link from "next/link";
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
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { cleanSearch, listProducts, PAGE_SIZE } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { getOrganisation, listCategories } from "@/lib/org";

export const metadata: Metadata = { title: `${t("catalog.products")} · ${t("app.name")}` };

type Search = { q?: string; category?: string; page?: string; saved?: string };

const pill = "border-border flex h-12 items-center rounded-full border px-5 text-sm font-medium";

export default async function ProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<Search>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  if (!org) notFound();
  const sp = await searchParams;
  const q = cleanSearch(sp.q);
  const page = Math.max(1, Math.min(10_000, Number.parseInt(sp.page ?? "1", 10) || 1));
  const category = sp.category ?? "";

  const [categories, { rows, total }] = await Promise.all([
    listCategories(orgId),
    listProducts(orgId, { q, categoryId: category, page }),
  ]);
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasModifiers = presets[org.businessType].productFields.includes("modifiers");
  const filtered = Boolean(q || category);
  const link = (p: number) => {
    const qs = new URLSearchParams();
    if (q) qs.set("q", q);
    if (category) qs.set("category", category);
    if (p > 1) qs.set("page", String(p));
    const s = qs.toString();
    return `/o/${orgId}/products${s ? `?${s}` : ""}`;
  };

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-semibold tracking-tight">{t("catalog.products")}</h1>
        <div className="flex flex-wrap gap-2">
          {hasModifiers ? (
            <Link href={`/o/${orgId}/products/modifiers`} className={pill}>
              {t("modifiers.title")}
            </Link>
          ) : null}
          <Link
            href={`/o/${orgId}/products/new`}
            className="bg-primary text-primary-foreground flex h-12 items-center rounded-full px-5 text-sm font-medium"
          >
            {t("catalog.new")}
          </Link>
        </div>
      </div>

      {sp.saved ? (
        <p role="status" tabIndex={-1} autoFocus className="rounded-lg border p-3 text-sm">
          {t("catalog.saved")}
        </p>
      ) : null}

      <form method="get" role="search" className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-60 flex-1 flex-col gap-1.5">
          <label htmlFor="q" className="text-sm font-medium">
            {t("catalog.search")}
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
        <div className="flex flex-col gap-1.5">
          <label htmlFor="category" className="text-sm font-medium">
            {t("catalog.category")}
          </label>
          <select
            id="category"
            name="category"
            defaultValue={category}
            className="border-input bg-background h-12 rounded-lg border px-3 text-base md:text-sm"
          >
            <option value="">{t("catalog.allCategories")}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <Button type="submit" variant="outline" className="h-12 px-5">
          {t("catalog.searchButton")}
        </Button>
      </form>

      {rows.length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="text-heading font-semibold">
            {filtered ? t("catalog.noMatches") : t("catalog.empty")}
          </h2>
          {filtered ? null : (
            <p className="text-muted-foreground mt-1 text-sm">{t("catalog.emptyBody")}</p>
          )}
        </div>
      ) : (
        <div className="surface-panel overflow-x-auto">
          <Table aria-label={t("catalog.listLabel")}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("catalog.col.name")}</TableHead>
                <TableHead scope="col">{t("catalog.col.category")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("catalog.col.price")}
                </TableHead>
                <TableHead scope="col">{t("catalog.col.barcode")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("catalog.col.stock")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <Link
                      href={`/o/${orgId}/products/${p.id}`}
                      className="inline-flex min-h-11 items-center underline-offset-4 hover:underline"
                    >
                      {p.name}
                    </Link>
                    {p.variantCount > 1 ? (
                      <span className="text-muted-foreground ml-2 text-xs font-normal">
                        {t("catalog.variantsCount", { n: p.variantCount })}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {(p.categoryId && categoryName.get(p.categoryId)) || t("catalog.noCategory")}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {p.minPrice === null
                      ? ""
                      : p.minPrice === p.maxPrice
                        ? formatCents(p.minPrice)
                        : `${formatCents(p.minPrice)} – ${formatCents(p.maxPrice!)}`}
                  </TableCell>
                  <TableCell className="font-mono">{p.barcode ?? ""}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {p.trackStock ? p.onHand : t("catalog.untracked")}
                  </TableCell>
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
