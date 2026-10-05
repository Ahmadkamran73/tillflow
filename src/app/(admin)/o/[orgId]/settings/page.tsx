import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: `${t("settings.title")} · ${t("app.name")}` };

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { role } = await requireRole(["owner", "manager"], orgId);

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("settings.title")}</h1>
      {role === "owner" ? (
        <ul className="surface-panel divide-border divide-y">
          <li>
            <Link
              href={`/o/${orgId}/settings/business-type`}
              className="flex min-h-12 items-center px-5 py-3 font-medium underline-offset-4 hover:underline"
            >
              {t("settings.businessType")}
            </Link>
          </li>
        </ul>
      ) : null}
    </section>
  );
}
