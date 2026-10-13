import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { IMPORT_TYPES, type ImportType } from "@/lib/import/fields";
import { xlsxStatus } from "@/lib/import/sandbox";
import { getOrganisation } from "@/lib/org";
import { ImportWizard } from "./import-wizard";

export const metadata: Metadata = { title: `${t("import.title")} · ${t("app.name")}` };

const TITLE = {
  products: "import.title",
  stock: "import.title.stock",
  customers: "import.title.customers",
} as const;
const INTRO = {
  products: "import.intro",
  stock: "import.intro.stock",
  customers: "import.intro.customers",
} as const;
const BACK = {
  products: "products",
  stock: "inventory",
  customers: "customers",
} as const;

/** /o/<org>/products/import?type=products|stock|customers (products when missing or unknown). */
export default async function ImportPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ type?: string }>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  if (!(await getOrganisation(orgId))) notFound();
  const asked = (await searchParams).type;
  const initialType: ImportType = (IMPORT_TYPES as readonly string[]).includes(asked ?? "")
    ? (asked as ImportType)
    : "products";
  // Excel is offered only when the isolated parser is switched on and this host passed its self-test.
  const xlsx = (await xlsxStatus()).state === "ready";
  return (
    <section className="flex max-w-4xl flex-col gap-4">
      <Link
        href={`/o/${orgId}/${BACK[initialType]}`}
        className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
      >
        {t("import.back")}
      </Link>
      <h1 className="text-title font-semibold tracking-tight">{t(TITLE[initialType])}</h1>
      <p className="text-muted-foreground text-sm">{t(INTRO[initialType])}</p>
      <ImportWizard orgId={orgId} xlsx={xlsx} initialType={initialType} />
    </section>
  );
}
