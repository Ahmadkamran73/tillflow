import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { authenticateDevice } from "@/lib/device/auth";
import { t } from "@/lib/i18n";
import { Register } from "./register";

export const metadata: Metadata = {
  title: `${t("register.title")} · ${t("app.name")}`,
  robots: { index: false },
};

export default async function RegisterPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  // The till is a paired device, not a signed-in user: its token (httpOnly cookie) must belong to
  // this shop. Anything else (never paired, revoked, another shop's till) goes to the pairing page.
  const device = await authenticateDevice(orgId);
  if (!device.ok) redirect("/register/pair");
  return <Register orgId={orgId} />;
}
