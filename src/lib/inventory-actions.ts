"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import type { FormState } from "@/lib/auth/schemas";
import { getLocation } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { adjustInput, thresholdInput } from "@/lib/inventory-schema";
import { logger } from "@/lib/logger";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

/** Record one stock movement (received, damage, count, adjustment) through public.adjust_stock. */
export async function adjustStockAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = adjustInput.safeParse({
    orgId: str(formData, "orgId"),
    variantId: str(formData, "variantId"),
    reason: str(formData, "reason"),
    qty: str(formData, "qty"),
    note: str(formData, "note"),
  });
  if (!parsed.success) {
    const noteBad = parsed.error.issues.some((i) => i.path[0] === "note");
    const qtyBad = parsed.error.issues.some((i) => i.path[0] === "qty");
    if (noteBad || qtyBad) {
      return {
        fieldErrors: {
          ...(qtyBad ? { qty: [t("inventory.err.qty")] } : {}),
          ...(noteBad ? { note: [t("inventory.err.note")] } : {}),
        },
      };
    }
    return { error: t("inventory.err.generic") };
  }
  const { orgId, variantId, reason, qty, note } = parsed.data;
  await requireRole(["owner", "manager"], orgId);
  const location = await getLocation(orgId);
  if (!location) return { error: t("inventory.err.generic") };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("adjust_stock", {
    p_org: orgId,
    p_variant: variantId,
    p_location: location.id,
    p_reason: reason,
    p_qty: qty,
    p_note: note,
  });
  if (error) {
    logger.error({ code: error.code }, "adjust_stock failed");
    return error.code === "22023" && error.message.includes("nothing to record")
      ? { fieldErrors: { qty: [t("inventory.err.nothing")] } }
      : { error: t("inventory.err.generic") };
  }
  redirect(`/o/${orgId}/inventory/${variantId}?saved=1`);
}

/** Set or clear a product's low-stock alert level. */
export async function setThresholdAction(formData: FormData): Promise<void> {
  const variantId = str(formData, "variantId");
  const parsed = thresholdInput.safeParse({
    orgId: str(formData, "orgId"),
    productId: str(formData, "productId"),
    threshold: str(formData, "threshold"),
  });
  if (!parsed.success) {
    const back = z.object({ o: z.uuid(), v: z.uuid() }).safeParse({
      o: str(formData, "orgId"),
      v: variantId,
    });
    redirect(back.success ? `/o/${back.data.o}/inventory/${back.data.v}?error=1` : "/o");
  }
  const { orgId, productId, threshold } = parsed.data;
  await requireRole(["owner", "manager"], orgId);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("products")
    .update({ low_stock_threshold: threshold })
    .eq("org_id", orgId)
    .eq("id", productId);
  if (error) {
    logger.error({ code: error.code }, "set threshold failed");
    redirect(`/o/${orgId}/inventory/${variantId}?error=1`);
  }
  redirect(`/o/${orgId}/inventory/${variantId}?saved=1`);
}
