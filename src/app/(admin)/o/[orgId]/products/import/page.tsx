import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { getOrganisation } from "@/lib/org";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: `${t("import.title")} · ${t("app.name")}` };

export default async function ImportPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  if (!(await getOrganisation(orgId))) notFound();
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <Link href={`/o/${orgId}/products`} className="inline-flex min-h-12 items-center text-sm underline underline-offset-4">
        {t("import.back")}
      </Link>
      <h1 className="text-title font-semibold tracking-tight">{t("import.title")}</h1>
      <p className="text-muted-foreground text-sm">{t("import.intro")}</p>
      <ImportWizard orgId={orgId} />
    </section>
  );
}
