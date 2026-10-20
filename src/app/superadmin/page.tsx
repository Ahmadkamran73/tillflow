import Link from "next/link";
import { z } from "zod";
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
import { requireSuperadmin } from "@/lib/auth";
import { t, type MessageKey } from "@/lib/i18n";
import { enIE } from "@/lib/i18n/en-IE";
import { irishDateTime, irishDay } from "@/lib/superadmin/format";
import { listOrgs, PAGE_SIZE } from "@/lib/superadmin/data";

export const dynamic = "force-dynamic";

const query = z.object({
  q: z.string().trim().max(100).catch(""),
  page: z.coerce.number().int().min(0).max(10_000).catch(0),
});

const label = (prefix: string, value: string | null, none: MessageKey): string => {
  if (!value) return t(none);
  const key = `${prefix}.${value}`;
  return key in enIE ? t(key as MessageKey) : value;
};

/** Superadmin only: every business with billing status, trial end, last payment and last sync. */
export default async function SuperadminHome({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { user } = await requireSuperadmin("/superadmin");
  const { q, page } = query.parse(await searchParams);
  const rows = await listOrgs(user.id, q, page);
  const hasNext = rows.length > PAGE_SIZE;
  const shown = rows.slice(0, PAGE_SIZE);
  const link = (p: number) => `/superadmin?${new URLSearchParams({ q, page: String(p) })}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-title font-semibold tracking-tight">{t("superadmin.orgs.title")}</h1>
        <p className="text-muted-foreground max-w-prose text-sm">{t("superadmin.orgs.intro")}</p>
      </div>

      <form method="get" className="flex max-w-md items-end gap-2">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor="q">{t("superadmin.orgs.search")}</Label>
          <Input id="q" name="q" defaultValue={q} maxLength={100} className="h-12" />
        </div>
        <Button type="submit" className="h-12 px-5">
          {t("superadmin.orgs.searchButton")}
        </Button>
      </form>

      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("superadmin.orgs.empty")}</p>
      ) : (
        <div
          className="surface-panel"
          role="region"
          tabIndex={0}
          aria-label={t("superadmin.orgs.title")}
        >
          <Table>
            <caption className="sr-only">{t("superadmin.orgs.title")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("superadmin.orgs.col.name")}</TableHead>
                <TableHead scope="col">{t("superadmin.orgs.col.status")}</TableHead>
                <TableHead scope="col">{t("superadmin.orgs.col.billing")}</TableHead>
                <TableHead scope="col">{t("superadmin.orgs.col.trialEnd")}</TableHead>
                <TableHead scope="col">{t("superadmin.orgs.col.lastPayment")}</TableHead>
                <TableHead scope="col">{t("superadmin.orgs.col.lastSync")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((o) => (
                <TableRow key={o.id}>
                  <TableHead scope="row" className="font-normal">
                    <Link
                      href={`/superadmin/orgs/${o.id}`}
                      className="inline-flex min-h-12 items-center font-medium underline"
                    >
                      {o.name}
                    </Link>
                  </TableHead>
                  <TableCell>
                    {label("superadmin.status", o.org_status, "superadmin.orgs.none")}
                  </TableCell>
                  <TableCell>
                    {label("superadmin.billing", o.billing_status, "superadmin.billing.none")}
                  </TableCell>
                  <TableCell>
                    {o.org_status === "trial"
                      ? irishDay(o.trial_ends_at, t("superadmin.orgs.none"))
                      : t("superadmin.orgs.none")}
                  </TableCell>
                  <TableCell>{irishDay(o.last_payment_at, t("superadmin.orgs.none"))}</TableCell>
                  <TableCell>{irishDateTime(o.last_sync_at, t("superadmin.orgs.never"))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <nav className="flex gap-4" aria-label={t("superadmin.pagination")}>
        {page > 0 ? (
          <Link href={link(page - 1)} className="inline-flex min-h-12 items-center underline">
            {t("superadmin.orgs.prev")}
          </Link>
        ) : null}
        {hasNext ? (
          <Link href={link(page + 1)} className="inline-flex min-h-12 items-center underline">
            {t("superadmin.orgs.next")}
          </Link>
        ) : null}
      </nav>
    </div>
  );
}
