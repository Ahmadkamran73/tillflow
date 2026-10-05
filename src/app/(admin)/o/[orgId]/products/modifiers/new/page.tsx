import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { v7 as uuidv7 } from "uuid";
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { getOrganisation } from "@/lib/org";
import { ModifierGroupForm } from "../modifier-group-form";

export const metadata: Metadata = { title: `${t("modifiers.new")} · ${t("app.name")}` };

export default async function NewModifierGroupPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  if (!org || !presets[org.businessType].productFields.includes("modifiers")) notFound();
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("modifiers.new")}</h1>
      <ModifierGroupForm
        orgId={orgId}
        initial={{
          groupId: uuidv7(),
          name: "",
          min: "0",
          max: "1",
          options: [{ id: uuidv7(), name: "", price: "" }],
        }}
      />
    </section>
  );
}
