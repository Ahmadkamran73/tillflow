import { notFound } from "next/navigation";
import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { viewDashboard } from "@/lib/superadmin/data";
import { viewGuard } from "../_guard";

export const dynamic = "force-dynamic";

export default async function ViewDashboard({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId, userId } = await viewGuard(params, "dashboard");
  const d = await viewDashboard(userId, orgId).catch(() => null);
  if (!d) notFound();
  const tiles: [string, string][] = [
    [t("superadmin.view.salesToday"), String(d.sales_today)],
    [t("superadmin.view.takingsToday"), formatCents(d.takings_today_cents)],
    [t("superadmin.view.sales7"), String(d.sales_7d)],
    [t("superadmin.view.takings7"), formatCents(d.takings_7d_cents)],
    [t("superadmin.org.usage.attention"), String(d.open_attention)],
    [t("superadmin.view.toReview"), String(d.to_review)],
  ];
  return (
    <section aria-labelledby="h" className="flex flex-col gap-4">
      <h1 id="h" className="text-title font-semibold tracking-tight">
        {t("superadmin.view.dashboard")}
      </h1>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map(([k, v]) => (
          <div key={k} className="surface-panel flex flex-col gap-1 p-4">
            <dt className="text-muted-foreground text-sm">{k}</dt>
            <dd className="text-amount font-mono tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
