import "server-only";
import { createSupabaseServerClient } from "@/lib/auth";

/** Display name of an organisation the caller belongs to. RLS returns nothing for any other org. */
export async function getOrganisationName(orgId: string): Promise<string | null> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("organisations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle();
  return data?.name ?? null;
}
