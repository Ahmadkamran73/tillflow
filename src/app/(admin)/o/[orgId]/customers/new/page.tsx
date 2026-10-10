import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { CustomerForm } from "../customer-form";

export const metadata: Metadata = { title: `${t("customers.new.title")} · ${t("app.name")}` };

export default async function NewCustomerPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("customers.new.title")}</h1>
      <CustomerForm
        orgId={orgId}
        initial={{ name: "", email: "", phone: "", vatNumber: "", address: "", notes: "" }}
      />
    </section>
  );
}
