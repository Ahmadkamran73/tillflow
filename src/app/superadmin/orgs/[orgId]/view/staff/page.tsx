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
import { viewStaff } from "@/lib/superadmin/data";
import { viewGuard } from "../_guard";

export const dynamic = "force-dynamic";

export default async function ViewStaff({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId, userId } = await viewGuard(params, "staff");
  const rows = await viewStaff(userId, orgId).catch(() => null);
  if (!rows) notFound();
  return (
    <section aria-labelledby="h" className="flex flex-col gap-4">
      <h1 id="h" className="text-title font-semibold tracking-tight">
        {t("superadmin.view.staff")}
      </h1>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("superadmin.view.empty")}</p>
      ) : (
        <div
          className="surface-panel"
          role="region"
          tabIndex={0}
          aria-label={t("superadmin.view.staff")}
        >
          <Table>
            <caption className="sr-only">{t("superadmin.view.staff")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("superadmin.view.col.name")}</TableHead>
                <TableHead scope="col">{t("superadmin.view.col.role")}</TableHead>
                <TableHead scope="col">{t("superadmin.view.col.kind")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m, i) => (
                <TableRow key={i}>
                  <TableHead scope="row" className="font-normal">
                    {m.display_name ?? t("superadmin.orgs.none")}
                  </TableHead>
                  <TableCell>{m.role}</TableCell>
                  <TableCell>
                    {m.till_only ? t("superadmin.view.tillStaff") : t("superadmin.view.loginStaff")}
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
