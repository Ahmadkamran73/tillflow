import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { getModifierGroup } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { centsToInput } from "@/lib/money";
import { getOrganisation } from "@/lib/org";
import { ModifierGroupForm } from "../modifier-group-form";

export const metadata: Metadata = { title: `${t("modifiers.edit")} · ${t("app.name")}` };

export default async function EditModifierGroupPage({
  params,
}: {
  params: Promise<{ orgId: string; groupId: string }>;
}) {
  const { orgId, groupId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  if (!org || !presets[org.businessType].productFields.includes("modifiers")) notFound();
  const group = await getModifierGroup(orgId, groupId);
  if (!group) notFound();
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("modifiers.edit")}</h1>
      <ModifierGroupForm
        orgId={orgId}
        initial={{
          groupId: group.id,
          name: group.name,
          min: String(group.min),
          max: String(group.max),
          options: group.options.map((o) => ({
            id: o.id,
            name: o.name,
            price: o.priceDeltaCents ? centsToInput(o.priceDeltaCents) : "",
          })),
        }}
      />
    </section>
  );
}
