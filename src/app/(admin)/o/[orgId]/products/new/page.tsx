import type { Metadata } from "next";
import { v7 as uuidv7 } from "uuid";
import { emptyProduct } from "@/lib/catalog-schema";
import { t } from "@/lib/i18n";
import { ProductForm } from "../product-form";
import { loadProductFormContext } from "../product-page";

export const metadata: Metadata = { title: `${t("catalog.new")} · ${t("app.name")}` };

export default async function NewProductPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const ctx = await loadProductFormContext(orgId);
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("catalog.new")}</h1>
      <ProductForm
        orgId={orgId}
        isNew
        initial={emptyProduct(ctx.businessType, uuidv7(), uuidv7())}
        {...ctx}
      />
    </section>
  );
}
