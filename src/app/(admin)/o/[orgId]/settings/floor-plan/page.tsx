import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { getOrganisation } from "@/lib/org";
import { getFloorPlan } from "@/lib/restaurant/floor-plan-server";
import { FloorPlanEditor } from "./floor-plan-editor";

export const metadata: Metadata = { title: `${t("floorplan.title")} · ${t("app.name")}` };

export default async function FloorPlanPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  if (!org || !presets[org.businessType].register.tablePlan) notFound();
  const plan = await getFloorPlan(orgId);

  return (
    <section className="flex max-w-5xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("floorplan.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("floorplan.intro")}</p>
      <FloorPlanEditor orgId={orgId} initial={plan} />
    </section>
  );
}
