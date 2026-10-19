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
import { PAGE_SIZE, viewSales } from "@/lib/superadmin/data";
import { irishDateTime } from "@/lib/superadmin/format";
import { viewGuard } from "../_guard";

export const dynamic = "force-dynamic";

const before = z.iso.datetime({ offset: true }).nullable().catch(null);

export default async function ViewSales({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ before?: string }>;
}) {
  const { orgId, userId } = await viewGuard(params, "sales");
  const cursor = before.parse((await searchParams).before ?? null);
  const rows = await viewSales(userId, orgId, cursor).catch(() => null);
  if (!rows) notFound();
  const last = rows.at(-1);
  return (
    <section aria-labelledby="h" className="flex flex-col gap-4">
      <h1 id="h" className="text-title font-semibold tracking-tight">
        {t("superadmin.view.sales")}
      </h1>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("superadmin.view.empty")}</p>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("superadmin.view.sales")}
        >
          <Table>
            <caption className="sr-only">{t("superadmin.view.sales")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("superadmin.view.col.receipt")}</TableHead>
                <TableHead scope="col">{t("superadmin.view.col.till")}</TableHead>
                <TableHead scope="col">{t("superadmin.view.col.time")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("superadmin.view.col.total")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("superadmin.view.col.vat")}
                </TableHead>
                <TableHead scope="col">{t("superadmin.view.col.flags")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableHead scope="row" className="font-mono font-normal">
                    {String(r.receipt_seq).padStart(6, "0")}
                  </TableHead>
                  <TableCell>{r.till}</TableCell>
                  <TableCell>{irishDateTime(r.completed_at, "")}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(r.amount_due_cents)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {formatCents(r.vat_cents)}
                  </TableCell>
                  <TableCell>{r.review_flags.join(", ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {rows.length === PAGE_SIZE && last ? (
        <Link
          href={`/superadmin/orgs/${orgId}/view/sales?before=${encodeURIComponent(new Date(last.completed_at).toISOString())}`}
          className="inline-flex min-h-12 w-fit items-center underline"
        >
          {t("superadmin.view.older")}
        </Link>
      ) : null}
    </section>
  );
}
