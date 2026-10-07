import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { t, type MessageKey } from "@/lib/i18n";

export const metadata: Metadata = { title: `${t("settings.title")} · ${t("app.name")}` };

const linkClass =
  "flex min-h-12 items-center px-5 py-3 font-medium underline-offset-4 hover:underline";

export default async function SettingsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const { role, user } = await requireRole(["owner", "manager"], orgId);

  const links: { href: string; label: MessageKey }[] = [
    { href: "tills", label: "tills.title" },
    { href: "pin", label: "pin.title" },
    ...(role === "owner"
      ? ([
          { href: "business-type", label: "settings.businessType" },
          { href: "vat", label: "settings.vat" },
          { href: "discount-limit", label: "discountLimit.title" },
        ] as const)
      : []),
  ];

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("settings.title")}</h1>
      <ul className="surface-panel divide-border divide-y">
        {links.map((l) => (
          <li key={l.href}>
            <Link href={`/o/${orgId}/settings/${l.href}`} className={linkClass}>
              {t(l.label)}
            </Link>
          </li>
        ))}
      </ul>
      <p className="surface-panel flex flex-wrap items-center justify-between gap-3 px-5 py-3">
        <span>
          {t("mfa.status")} <strong>{user.hasVerifiedFactor ? t("mfa.on") : t("mfa.off")}</strong>
        </span>
        {user.hasVerifiedFactor ? null : (
          <Link
            href={`/mfa?next=${encodeURIComponent(`/o/${orgId}/settings`)}`}
            className="inline-flex min-h-12 items-center font-medium underline underline-offset-4"
          >
            {t("mfa.setUp")}
          </Link>
        )}
      </p>
    </section>
  );
}
