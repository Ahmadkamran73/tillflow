import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { PAGE_SIZE, viewProducts } from "@/lib/superadmin/data";
import { viewGuard } from "../_guard";

export const dynamic = "force-dynamic";

const pageNo = z.coerce.number().int().min(0).max(10_000).catch(0);

export default async function ViewProducts({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  const { orgId, userId } = await viewGuard(params, "products");
  const page = pageNo.parse((await searchParams).page);
  const all = await viewProducts(userId, orgId, page).catch(() => null);
  if (!all) notFound();
  const rows = all.slice(0, PAGE_SIZE);
  const href = (p: number) => `/superadmin/orgs/${orgId}/view/products?page=${p}`;
  return (
    <section aria-labelledby="h" className="flex flex-col gap-4">
      <h1 id="h" className="text-title font-semibold tracking-tight">
        {t("superadmin.view.products")}
      </h1>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("superadmin.view.empty")}</p>
      ) : (
        <div
          className="surface-panel"
          role="region"
          tabIndex={0}
          aria-label={t("superadmin.view.products")}
        >
          <Table>
            <caption className="sr-only">{t("superadmin.view.products")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("superadmin.view.col.product")}</TableHead>
                <TableHead scope="col">{t("superadmin.view.col.tax")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("superadmin.view.col.price")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("superadmin.view.col.variants")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow key={p.id}>
                  <TableHead scope="row" className="font-normal">
                    {p.name}
                  </TableHead>
                  <TableCell>{p.tax_category}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {p.price_from_cents === null
                      ? t("superadmin.orgs.none")
                      : formatCents(p.price_from_cents)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{p.variants}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <nav className="flex gap-4" aria-label={t("superadmin.pagination")}>
        {page > 0 ? (
          <Link href={href(page - 1)} className="inline-flex min-h-12 items-center underline">
            {t("superadmin.orgs.prev")}
          </Link>
        ) : null}
        {all.length > PAGE_SIZE ? (
          <Link href={href(page + 1)} className="inline-flex min-h-12 items-center underline">
            {t("superadmin.orgs.next")}
          </Link>
        ) : null}
      </nav>
    </section>
  );
}
