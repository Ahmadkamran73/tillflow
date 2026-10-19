"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import type { FormState } from "@/lib/auth/schemas";
import { parseProductForm, type FieldErrors } from "@/lib/catalog-schema";
import { getLocation } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { parseModifierGroupForm } from "@/lib/modifier-schema";
import { getOrganisation } from "@/lib/org";

const MAX_PAYLOAD = 200_000;

function readPayload(formData: FormData): unknown {
  const raw = formData.get("payload");
  if (typeof raw !== "string" || raw.length > MAX_PAYLOAD) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const orgIdOf = (formData: FormData) => {
  const v = formData.get("orgId");
  return z.uuid().safeParse(typeof v === "string" ? v : "");
};

/** Create or edit a product with its variants, stock, and modifier links (one transaction). */
export async function saveProductAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const orgId = orgIdOf(formData);
  if (!orgId.success) return { error: t("catalog.error") };
  await requireRole(["owner", "manager"], orgId.data);

  const org = await getOrganisation(orgId.data);
  const location = await getLocation(orgId.data);
  if (!org || !location) return { error: t("catalog.error") };

  const payload = readPayload(formData);
  const productId = z.uuid().safeParse((payload as { productId?: unknown } | null)?.productId);
  if (!productId.success) return { error: t("catalog.error") };

  const supabase = await createSupabaseServerClient();
  const { data: existing } = await supabase
    .from("products")
    .select("id")
    .eq("org_id", orgId.data)
    .eq("id", productId.data)
    .maybeSingle();

  const parsed = parseProductForm(org.businessType, payload, { isNew: !existing });
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };
  const { data } = parsed;

  // Friendly per-row errors for a barcode or SKU another product already uses.
  const taken: FieldErrors = {};
  for (const field of ["barcode", "sku"] as const) {
    const values = data.variants.map((v) => v[field]).filter((v): v is string => !!v);
    if (!values.length) continue;
    const { data: rows } = await supabase
      .from("variants")
      .select(`${field}`)
      .eq("org_id", orgId.data)
      .neq("product_id", productId.data)
      .in(field, values);
    const used = new Set((rows ?? []).map((r) => (r as unknown as Record<string, string>)[field]));
    data.variants.forEach((v, i) => {
      if (v[field] && used.has(v[field])) {
        taken[`variants.${i}.${field}`] = [
          t(field === "barcode" ? "catalog.err.barcodeDup" : "catalog.err.skuDup"),
        ];
      }
    });
  }
  if (Object.keys(taken).length) return { fieldErrors: taken };

  const { error } = await supabase.rpc("save_product", {
    p: { org_id: orgId.data, location_id: location.id, ...data },
  });
  if (error) {
    logger.error({ code: error.code }, "save_product failed");
    return error.code === "23505"
      ? { error: t("catalog.err.barcodeDup") }
      : { error: t("catalog.error") };
  }
  redirect(`/o/${orgId.data}/products?saved=1`);
}

export async function archiveProductAction(formData: FormData): Promise<void> {
  const orgId = orgIdOf(formData);
  if (!orgId.success) redirect("/o");
  await requireRole(["owner", "manager"], orgId.data);
  const productId = z.uuid().safeParse(formData.get("productId"));
  if (productId.success) {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase
      .from("products")
      .update({ archived_at: new Date().toISOString() })
      .eq("org_id", orgId.data)
      .eq("id", productId.data);
    if (error) logger.error({ code: error.code }, "archive product failed");
  }
  redirect(`/o/${orgId.data}/products`);
}

export async function saveModifierGroupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const orgId = orgIdOf(formData);
  if (!orgId.success) return { error: t("modifiers.error") };
  await requireRole(["owner", "manager"], orgId.data);

  const parsed = parseModifierGroupForm(readPayload(formData));
  if (!parsed.ok) return { fieldErrors: parsed.fieldErrors };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("save_modifier_group", {
    p: { org_id: orgId.data, ...parsed.data },
  });
  if (error) {
    logger.error({ code: error.code }, "save_modifier_group failed");
    return error.code === "23505"
      ? { fieldErrors: { name: [t("modifiers.nameTaken")] } }
      : { error: t("modifiers.error") };
  }
  redirect(`/o/${orgId.data}/products/modifiers?saved=1`);
}
