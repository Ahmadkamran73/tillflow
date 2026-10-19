import { notFound } from "next/navigation";
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
import { viewShifts } from "@/lib/superadmin/data";
import { irishDateTime } from "@/lib/superadmin/format";
import { viewGuard } from "../_guard";

export const dynamic = "force-dynamic";

export default async function ViewShifts({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId, userId } = await viewGuard(params, "shifts");
  const rows = await viewShifts(userId, orgId).catch(() => null);
  if (!rows) notFound();
  const money = (c: number | null) => (c === null ? "" : formatCents(c));
  const right = "text-right font-mono tabular-nums";
  return (
    <section aria-labelledby="h" className="flex flex-col gap-4">
      <h1 id="h" className="text-title font-semibold tracking-tight">
        {t("superadmin.view.shifts")}
      </h1>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("superadmin.view.empty")}</p>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("superadmin.view.shifts")}
        >
          <Table>
            <caption className="sr-only">{t("superadmin.view.shifts")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("superadmin.view.col.till")}</TableHead>
                <TableHead scope="col">{t("superadmin.view.col.opened")}</TableHead>
                <TableHead scope="col">{t("superadmin.view.col.closed")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("superadmin.view.col.float")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("superadmin.view.col.counted")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("superadmin.view.col.expected")}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {t("superadmin.view.col.overShort")}
                </TableHead>
                <TableHead scope="col">{t("superadmin.view.col.z")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id}>
                  <TableHead scope="row" className="font-normal">
                    {s.till}
                  </TableHead>
                  <TableCell>{irishDateTime(s.opened_at, "")}</TableCell>
                  <TableCell>
                    {irishDateTime(s.closed_at, t("superadmin.view.stillOpen"))}
                  </TableCell>
                  <TableCell className={right}>{formatCents(s.float_cents)}</TableCell>
                  <TableCell className={right}>{money(s.counted_cents)}</TableCell>
                  <TableCell className={right}>{money(s.expected_cents)}</TableCell>
                  <TableCell className={right}>{money(s.over_short_cents)}</TableCell>
                  <TableCell className="font-mono">
                    {s.z_seq === null ? "" : `Z${String(s.z_seq).padStart(4, "0")}`}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
