import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { Register } from "./register";

export const metadata: Metadata = {
  title: `${t("register.title")} · ${t("app.name")}`,
  robots: { index: false },
};

export default async function RegisterPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  // Until device pairing and PINs (step 1.7), any member of the shop may open the till.
  await requireRole(["owner", "manager", "cashier"], orgId);
  return <Register orgId={orgId} />;
}
