import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { getOrganisation, listCategories } from "@/lib/org";

export const metadata: Metadata = { title: `${t("dashboard.title")} · ${t("app.name")}` };

export default async function DashboardPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId); // layouts do not protect the page on their own
  const [org, categories] = await Promise.all([getOrganisation(orgId), listCategories(orgId)]);
  if (!org) notFound();
  const tiles = presets[org.businessType].dashboardTiles;

  return (
    <section className="flex max-w-5xl flex-col gap-6">
      <h1 className="text-title font-semibold tracking-tight">{t("dashboard.title")}</h1>

      <dl className="surface-panel divide-border grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {tiles.map((tile) => (
          <div key={tile} className="flex flex-col gap-1 p-5">
            <dt className="text-muted-foreground font-mono text-xs tracking-wide">
              {t(`tile.${tile}`)}
            </dt>
            <dd className="text-muted-foreground text-sm">{t("tile.empty")}</dd>
          </div>
        ))}
      </dl>

      <section aria-labelledby="categories" className="surface-panel flex flex-col gap-3 p-5">
        <h2 id="categories" className="text-heading font-semibold">
          {t("dashboard.categories")}
        </h2>
        {categories.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("dashboard.categoriesEmpty")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-full border px-3 py-1">
                <span
                  aria-hidden
                  className="size-3 rounded-full"
                  style={{ backgroundColor: c.colour ?? undefined }}
                />
                {c.name}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="surface-panel p-8 text-center">
        <h2 className="font-display text-heading font-semibold">{t("dashboard.emptyTitle")}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{t("dashboard.emptyBody")}</p>
      </div>
    </section>
  );
}
