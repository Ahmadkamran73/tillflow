import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireBackOffice } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { getOrganisation } from "@/lib/org";
import { OnboardingWizard } from "./onboarding-wizard";

export const metadata: Metadata = { title: `${t("onboarding.title")} · ${t("app.name")}` };

export default async function OnboardingPage() {
  const { orgId, role } = await requireBackOffice("/onboarding");
  const org = await getOrganisation(orgId);
  if (!org) notFound();
  // Set up once, by the owner. Everyone else (and a second visit) goes to the dashboard.
  if (role !== "owner" || org.onboardedAt) redirect(`/o/${orgId}/dashboard`);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 px-4 py-10">
      <h1 className="text-muted-foreground text-sm font-medium">{t("onboarding.title")}</h1>
      <OnboardingWizard orgId={orgId} defaultName={org.name} />
    </main>
  );
}
