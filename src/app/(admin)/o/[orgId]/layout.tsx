import { TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { BackOfficeShell } from "@/components/back-office/shell";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { getBillingBanner } from "@/lib/billing/owner";
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
  const billing = await getBillingBanner(orgId);

  return (
    <BackOfficeShell orgId={orgId} orgName={org.name} role={role}>
      {user.hasVerifiedFactor ? null : (
        <aside
          aria-label={t("mfa.reminderLabel")}
          className="border-border bg-muted mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm"
        >
          <span>{t("mfa.reminder")}</span>
          <Link
            href={`/mfa?next=${encodeURIComponent(`/o/${orgId}/settings`)}`}
            className="inline-flex min-h-12 items-center font-medium underline underline-offset-4"
          >
            {t("mfa.reminderLink")}
          </Link>
        </aside>
      )}
      {billing ? (
        <div
          role="region"
          aria-label={t("billing.noticeLabel")}
          className={`mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 px-4 py-3 text-sm font-medium ${billing === "paused" ? "border-destructive bg-muted" : "border-warning bg-warning text-warning-foreground"}`}
        >
          <span className="inline-flex items-center gap-2">
            <TriangleAlertIcon aria-hidden className="size-5 shrink-0" />
            {t(billing === "paused" ? "billing.readOnlyBanner" : "billing.overdueBanner")}
          </span>
          {role === "owner" ? (
            <Link
              href={`/o/${orgId}/billing`}
              className="inline-flex min-h-12 items-center font-medium underline underline-offset-4"
            >
              {t("billing.readOnlyBannerLink")}
            </Link>
          ) : null}
        </div>
      ) : null}
      {children}
    </BackOfficeShell>
  );
}
