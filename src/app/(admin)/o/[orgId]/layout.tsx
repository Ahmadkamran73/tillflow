import { notFound, redirect } from "next/navigation";
import { BackOfficeShell } from "@/components/back-office/shell";
import { requireRole } from "@/lib/auth";
import { getOrganisation } from "@/lib/org";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { role } = await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  if (!org) notFound();
  if (!org.onboardedAt && role === "owner") redirect("/onboarding");

  return (
    <BackOfficeShell orgId={orgId} orgName={org.name} role={role}>
      {children}
    </BackOfficeShell>
  );
}
