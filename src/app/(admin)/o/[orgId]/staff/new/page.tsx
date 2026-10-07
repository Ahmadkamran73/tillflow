import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { NewCashierForm } from "./new-cashier-form";

export const metadata: Metadata = { title: `${t("staff.newTitle")} · ${t("app.name")}` };

export default async function NewCashierPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("staff.newTitle")}</h1>
      <p className="max-w-prose text-sm">{t("staff.newBody")}</p>
      <NewCashierForm orgId={orgId} />
      <Link
        href={`/o/${orgId}/staff`}
        className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
      >
        {t("staff.back")}
      </Link>
    </section>
  );
}
