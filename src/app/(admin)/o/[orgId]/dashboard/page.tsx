import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { listStock } from "@/lib/inventory";
import { getOrganisation, listCategories } from "@/lib/org";
import { getAttention } from "@/lib/sync/attention";

export const metadata: Metadata = { title: `${t("dashboard.title")} · ${t("app.name")}` };

export default async function DashboardPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId); // layouts do not protect the page on their own
  const [org, categories] = await Promise.all([getOrganisation(orgId), listCategories(orgId)]);
  if (!org) notFound();
  const attention = await getAttention(orgId);
  const location = await getLocation(orgId);
  const stock = location ? await listStock(orgId, location.id, { filter: "all", page: 1 }) : null;
  const lowProducts = stock?.lowProducts ?? 0;
  const tiles = presets[org.businessType].dashboardTiles;

  return (
    <section className="flex max-w-5xl flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-semibold tracking-tight">{t("dashboard.title")}</h1>
        <Link href={`/register/${orgId}`} className={buttonVariants({ size: "touch" })}>
          {t("dashboard.openRegister")}
        </Link>
      </div>

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

      {(attention.open > 0 ||
        attention.toReview > 0 ||
        attention.staleTills.length > 0 ||
        lowProducts > 0) && (
        <section aria-labelledby="attention" className="surface-panel flex flex-col gap-2 p-5">
          <h2 id="attention" className="text-heading font-semibold">
            {t("tile.attention")}
          </h2>
          {attention.open > 0 && (
            <p>
              <Link href={`/o/${orgId}/sales/attention`} className="font-medium underline">
                {t("sales.attentionLink", { count: attention.open })}
              </Link>
            </p>
          )}
          {attention.toReview > 0 && (
            <p>
              <Link
                href={`/o/${orgId}/sales/review`}
                className="inline-flex min-h-12 items-center font-medium underline"
              >
                {t("sales.reviewLink", { count: attention.toReview })}
              </Link>
            </p>
          )}
          {lowProducts > 0 && (
            <p>
              <Link
                href={`/o/${orgId}/inventory?filter=low`}
                className="inline-flex min-h-12 items-center font-medium underline"
              >
                {t("inventory.attentionLow", { count: lowProducts })}
              </Link>
            </p>
          )}
          {attention.staleTills.map((till) => (
            <p key={till} className="text-sm">
              {t("tile.attentionStale", { till })}
            </p>
          ))}
        </section>
      )}

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
