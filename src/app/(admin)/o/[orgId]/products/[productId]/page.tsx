import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getProduct } from "@/lib/catalog";
import { archiveProductAction } from "@/lib/catalog-actions";
import { rawFromProduct } from "@/lib/catalog-schema";
import { t } from "@/lib/i18n";
import { ProductForm } from "../product-form";
import { loadProductFormContext } from "../product-page";

export const metadata: Metadata = { title: `${t("catalog.edit")} · ${t("app.name")}` };

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ orgId: string; productId: string }>;
}) {
  const { orgId, productId } = await params;
  const ctx = await loadProductFormContext(orgId);
  const product = await getProduct(orgId, productId);
  if (!product) notFound();
  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("catalog.edit")}</h1>
      <ProductForm
        orgId={orgId}
        isNew={false}
        initial={rawFromProduct(ctx.businessType, product)}
        {...ctx}
      />
      <form action={archiveProductAction} className="max-w-4xl">
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="productId" value={product.id} />
        <Button type="submit" variant="outline" className="h-12 px-5">
          {t("catalog.archive")}
        </Button>
      </form>
    </section>
  );
}
