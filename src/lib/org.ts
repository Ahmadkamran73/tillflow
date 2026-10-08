import "server-only";
import { z } from "zod";
import { businessTypes } from "@/config/business-type-presets";
import { createSupabaseServerClient } from "@/lib/auth";

const orgRow = z.object({
  name: z.string(),
  legal_name: z.string().nullable(),
  vat_number: z.string().nullable(),
  business_type: z.enum(businessTypes),
  onboarded_at: z.string().nullable(),
  vat_rates_confirmed_at: z.string().nullable(),
  discount_override_bp: z.number().int(),
  refund_override_cents: z.number().int(),
});

/** An organisation the caller belongs to. RLS returns nothing for any other org. */
export async function getOrganisation(orgId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("organisations")
    .select(
      "name, legal_name, vat_number, business_type, onboarded_at, vat_rates_confirmed_at, discount_override_bp, refund_override_cents",
    )
    .eq("id", orgId)
    .maybeSingle();
  if (!data) return null;
  const row = orgRow.parse(data);
  return {
    name: row.name,
    legalName: row.legal_name,
    vatNumber: row.vat_number,
    businessType: row.business_type,
    onboardedAt: row.onboarded_at,
    vatRatesConfirmedAt: row.vat_rates_confirmed_at,
    discountOverrideBp: row.discount_override_bp,
    refundOverrideCents: row.refund_override_cents,
  };
}

/** The org's categories in register order, read through RLS. */
export async function listCategories(orgId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("categories")
    .select("id, name, colour")
    .eq("org_id", orgId)
    .order("sort");
  if (error) throw new Error("Could not load categories");
  return z
    .array(z.object({ id: z.string(), name: z.string(), colour: z.string().nullable() }))
    .parse(data);
}
