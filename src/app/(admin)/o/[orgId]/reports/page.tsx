import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { getOrganisation } from "@/lib/org";
import { REPORT_DEFS, reportsFor } from "@/lib/reports/registry";

export const metadata: Metadata = { title: `${t("reports.title")} · ${t("app.name")}` };

/** The reports this shop's business type offers. Managers and owners. */
export default async function ReportsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  if (!org) notFound();

  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("reports.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("reports.intro")}</p>
      <ul className="grid gap-3 sm:grid-cols-2">
        {reportsFor(org.businessType).map((id) => (
          <li key={id} className="surface-panel flex flex-col gap-1 p-5">
            <Link
              href={`/o/${orgId}/reports/${id}`}
              className="text-heading inline-flex min-h-12 items-center font-semibold underline-offset-4 hover:underline"
            >
              {t(REPORT_DEFS[id].title)}
            </Link>
            <p className="text-muted-foreground text-sm">{t(REPORT_DEFS[id].blurb)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
