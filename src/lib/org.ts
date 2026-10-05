import "server-only";
import { z } from "zod";
import { businessTypes } from "@/config/business-type-presets";
import { createSupabaseServerClient } from "@/lib/auth";

const orgRow = z.object({
  name: z.string(),
  business_type: z.enum(businessTypes),
  onboarded_at: z.string().nullable(),
  vat_rates_confirmed_at: z.string().nullable(),
});

/** An organisation the caller belongs to. RLS returns nothing for any other org. */
export async function getOrganisation(orgId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("organisations")
    .select("name, business_type, onboarded_at, vat_rates_confirmed_at")
    .eq("id", orgId)
    .maybeSingle();
  if (!data) return null;
  const row = orgRow.parse(data);
  return {
    name: row.name,
    businessType: row.business_type,
    onboardedAt: row.onboarded_at,
    vatRatesConfirmedAt: row.vat_rates_confirmed_at,
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
