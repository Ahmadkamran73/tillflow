import { notFound } from "next/navigation";
import Link from "next/link";
import { z } from "zod";
import { requireSuperadmin } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { orgName } from "@/lib/superadmin/data";

/**
 * The read-only "view as owner" frame. The banner lives here so no view page can leave it out.
 * There is NO form, posting button or server action anywhere under this layout: the pages are plain
 * tables fed by audited admin_view_* functions, and the admin never gets the owner's session.
 */
const PAGES = ["dashboard", "sales", "products", "staff", "shifts"] as const;

export default async function ViewLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const id = z.uuid().safeParse((await params).orgId);
  if (!id.success) notFound();
  const { user } = await requireSuperadmin(`/superadmin/orgs/${id.data}/view/dashboard`);
  const name = await orgName(user.id, id.data).catch(() => null);
  if (!name) notFound();
  return (
    <div className="flex flex-col gap-6">
      <div
        role="note"
        className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 rounded-md bg-red-700 px-4 py-3 text-sm font-semibold text-white"
      >
        <span>{t("superadmin.view.banner", { name })}</span>
        <Link
          href={`/superadmin/orgs/${id.data}`}
          className="inline-flex min-h-12 items-center rounded-full border-2 border-white px-4 underline"
        >
          {t("superadmin.view.exit")}
        </Link>
      </div>
      <nav aria-label={t("superadmin.view.nav")}>
        <ul className="flex flex-wrap gap-2">
          {PAGES.map((p) => (
            <li key={p}>
              <Link
                href={`/superadmin/orgs/${id.data}/view/${p}`}
                className="border-border inline-flex min-h-12 items-center rounded-full border-2 px-4 text-sm font-medium"
              >
                {t(`superadmin.view.${p}`)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {children}
    </div>
  );
}
