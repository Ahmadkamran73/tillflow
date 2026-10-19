import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BusinessTypeCards } from "@/components/back-office/business-type-cards";
import { Button } from "@/components/ui/button";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { getOrganisation } from "@/lib/org";
import { setBusinessTypeAction } from "@/lib/org-actions";

export const metadata: Metadata = { title: `${t("settings.businessType")} · ${t("app.name")}` };

export default async function BusinessTypePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  await requireRole("owner", orgId);
  const org = await getOrganisation(orgId);
  if (!org) notFound();
  const { result } = await searchParams;

  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <h1 id="business-type-title" className="text-title font-semibold tracking-tight">
        {t("settings.businessType")}
      </h1>
      <p id="business-type-help" className="text-muted-foreground max-w-prose text-sm">
        {t("settings.businessTypeBody")}
      </p>
      {result === "saved" ? (
        <p role="status" tabIndex={-1} autoFocus className="rounded-lg border p-3 text-sm">
          {t("settings.saved")}
        </p>
      ) : result ? (
        <p role="alert" tabIndex={-1} autoFocus className="text-destructive text-sm">
          {t("settings.error")}
        </p>
      ) : null}
      <form action={setBusinessTypeAction} className="flex flex-col gap-4">
        <input type="hidden" name="orgId" value={orgId} />
        <fieldset aria-labelledby="business-type-title">
          {/* key: a saved change re-renders the cards with the new default selection */}
          <BusinessTypeCards
            key={org.businessType}
            defaultValue={org.businessType}
            describedBy="business-type-help"
          />
        </fieldset>
        <Button type="submit" className="h-12 w-fit px-5">
          {t("settings.save")}
        </Button>
      </form>
    </section>
  );
}
