import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: `${t("dashboard.title")} · ${t("app.name")}` };

export default async function DashboardPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId); // layouts do not protect the page on their own

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("dashboard.title")}</h1>
      <div className="surface-panel p-8 text-center">
        <p className="font-display text-heading font-semibold">{t("dashboard.emptyTitle")}</p>
        <p className="text-muted-foreground mt-1 text-sm">{t("dashboard.emptyBody")}</p>
      </div>
    </section>
  );
}
