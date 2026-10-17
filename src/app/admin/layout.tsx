import type { Metadata } from "next";
import Link from "next/link";
import { t } from "@/lib/i18n";

export const metadata: Metadata = {
  title: `${t("admin.billing.title")} · ${t("app.name")}`,
  robots: { index: false, follow: false },
};

/** The Tillflow super-admin frame. Each page does its own requirePlatformAdmin() check. */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background min-h-screen">
      <a
        href="#main"
        className="bg-background sr-only z-50 rounded-md px-4 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t("nav.skip")}
      </a>
      <header className="border-border border-b px-4 py-3 sm:px-6">
        <Link href="/admin/billing" className="font-display text-lg font-semibold">
          {t("app.name")} · {t("admin.billing.title")}
        </Link>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}
