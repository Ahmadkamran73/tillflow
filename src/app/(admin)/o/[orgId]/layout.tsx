import { notFound } from "next/navigation";
import { BackOfficeShell } from "@/components/back-office/shell";
import { requireRole } from "@/lib/auth";
import { getOrganisationName } from "@/lib/org";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;
  const { role } = await requireRole(["owner", "manager"], orgId);
  const orgName = await getOrganisationName(orgId);
  if (!orgName) notFound();

  return (
    <BackOfficeShell orgId={orgId} orgName={orgName} role={role}>
      {children}
    </BackOfficeShell>
  );
}
