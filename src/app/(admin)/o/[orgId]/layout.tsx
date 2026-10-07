import Link from "next/link";
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
  const { role, user } = await requireRole(["owner", "manager"], orgId);
  const org = await getOrganisation(orgId);
  if (!org) notFound();
  if (!org.onboardedAt && role === "owner") redirect("/onboarding");

  return (
    <BackOfficeShell orgId={orgId} orgName={org.name} role={role}>
      {user.hasVerifiedFactor ? null : (
        <div
          role="status"
          className="border-border bg-muted mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
        >
          <span>Two-step verification is off. Turn it on to protect your shop&apos;s data.</span>
          <Link
            href={`/mfa?next=${encodeURIComponent(`/o/${orgId}/settings`)}`}
            className="inline-flex min-h-12 items-center font-medium underline underline-offset-4"
          >
            Set it up now
          </Link>
        </div>
      )}
      {children}
    </BackOfficeShell>
  );
}
