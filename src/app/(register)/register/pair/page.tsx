import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authenticateDevice } from "@/lib/device/auth";
import { t } from "@/lib/i18n";
import { PairForm } from "./pair-form";

export const metadata: Metadata = {
  title: `${t("pair.title")} · ${t("app.name")}`,
  robots: { index: false },
};

export default async function PairPage() {
  // Already paired: straight to the till.
  const device = await authenticateDevice();
  if (device.ok) redirect(`/register/${device.orgId}`);
  return <PairForm />;
}
