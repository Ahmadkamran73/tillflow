"use server";

import { redirect } from "next/navigation";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { presets, type BusinessType } from "@/config/business-type-presets";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { fieldErrorsOf, type FormState } from "@/lib/auth/schemas";
import { logger } from "@/lib/logger";
import { businessTypeInput, onboardingInput } from "@/lib/onboarding";

const str = (formData: FormData, key: string) => {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
};

/** Starter categories come from the server-side preset, not the form. (An owner calling the RPC directly could pass others, but only into their own org.) */
const starterCategories = (type: BusinessType) =>
  presets[type].starterCategories.map((c) => ({ id: uuidv7(), ...c }));

export async function completeOnboardingAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const orgId = z.uuid().safeParse(str(formData, "orgId"));
  if (!orgId.success) return { error: "We could not finish setting up. Please try again." };
  await requireRole("owner", orgId.data);

  const parsed = onboardingInput.safeParse({
    businessName: str(formData, "businessName"),
    vatNumber: str(formData, "vatNumber"),
    businessType: str(formData, "businessType"),
    tills: str(formData, "tills"),
    products: str(formData, "products"),
  });
  if (!parsed.success) return { fieldErrors: fieldErrorsOf(parsed.error) };
  const input = parsed.data;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("complete_onboarding", {
    p_org_id: orgId.data,
    p_name: input.businessName,
    p_vat_number: input.vatNumber,
    p_business_type: input.businessType,
    p_location_id: uuidv7(),
    p_register_ids: Array.from({ length: input.tills }, () => uuidv7()),
    p_categories: starterCategories(input.businessType),
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "complete_onboarding failed");
    return { error: "We could not finish setting up. Please try again." };
  }
  // ponytail: "import" lands on the dashboard too; send it to the import screen once that exists.
  redirect(`/o/${orgId.data}/dashboard`);
}

export async function setBusinessTypeAction(formData: FormData): Promise<void> {
  const orgId = z.uuid().safeParse(str(formData, "orgId"));
  if (!orgId.success) redirect("/o");
  await requireRole("owner", orgId.data);
  const page = `/o/${orgId.data}/settings/business-type`;

  const parsed = businessTypeInput.safeParse({ businessType: str(formData, "businessType") });
  if (!parsed.success) redirect(`${page}?result=invalid`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_business_type", {
    p_org_id: orgId.data,
    p_business_type: parsed.data.businessType,
    p_categories: starterCategories(parsed.data.businessType),
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "set_business_type failed");
    redirect(`${page}?result=error`);
  }
  redirect(`${page}?result=saved`);
}
