import type { Metadata } from "next";
import Link from "next/link";
import { t } from "@/lib/i18n";

export const metadata: Metadata = {
  title: `${t("superadmin.title")} · ${t("app.name")}`,
  robots: { index: false, follow: false },
};

/** The Tillflow superadmin frame. Every page and action does its own requireSuperadmin() check. */
export default function SuperadminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background min-h-screen">
      <a
        href="#main"
        className="bg-background sr-only z-50 rounded-md px-4 py-2 focus:not-sr-only focus:absolute focus:top-2 focus:left-2"
      >
        {t("nav.skip")}
      </a>
      <header className="border-border flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3 sm:px-6">
        <Link href="/superadmin" className="font-display text-lg font-semibold">
          {t("app.name")} · {t("superadmin.title")}
        </Link>
        <nav aria-label={t("superadmin.title")}>
          <ul className="flex gap-4 text-sm font-medium">
            <li>
              <Link href="/superadmin" className="inline-flex min-h-12 items-center underline">
                {t("superadmin.nav.orgs")}
              </Link>
            </li>
            <li>
              <Link
                href="/superadmin/billing"
                className="inline-flex min-h-12 items-center underline"
              >
                {t("superadmin.nav.billing")}
              </Link>
            </li>
          </ul>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}
