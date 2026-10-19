import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { listModifierGroups } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { getOrganisation } from "@/lib/org";

export const metadata: Metadata = { title: `${t("modifiers.title")} · ${t("app.name")}` };

export default async function ModifierGroupsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ saved?: string }>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  if (!org || !presets[org.businessType].productFields.includes("modifiers")) notFound();
  const groups = await listModifierGroups(orgId);
  const { saved } = await searchParams;

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-title font-semibold tracking-tight">{t("modifiers.title")}</h1>
        <Link
          href={`/o/${orgId}/products/modifiers/new`}
          className="bg-primary text-primary-foreground flex h-12 items-center rounded-full px-5 text-sm font-medium"
        >
          {t("modifiers.new")}
        </Link>
      </div>

      {saved ? (
        <p role="status" tabIndex={-1} autoFocus className="rounded-lg border p-3 text-sm">
          {t("modifiers.saved")}
        </p>
      ) : null}

      {groups.length === 0 ? (
        <div className="surface-panel p-8 text-center">
          <h2 className="text-heading font-semibold">{t("modifiers.empty")}</h2>
          <p className="text-muted-foreground mt-1 text-sm">{t("modifiers.emptyBody")}</p>
        </div>
      ) : (
        <ul className="surface-panel divide-border divide-y">
          {groups.map((g) => (
            <li key={g.id}>
              <Link
                href={`/o/${orgId}/products/modifiers/${g.id}`}
                className="flex min-h-14 flex-col justify-center gap-0.5 px-5 py-3 underline-offset-4 hover:underline"
              >
                <span className="font-medium">{g.name}</span>
                <span className="text-muted-foreground text-sm">
                  {t("modifiers.choices", { min: g.min, max: g.max })} ·{" "}
                  {g.options
                    .map(
                      (o) =>
                        o.name + (o.priceDeltaCents ? ` (${formatCents(o.priceDeltaCents)})` : ""),
                    )
                    .join(", ")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
