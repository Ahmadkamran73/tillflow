import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth";
import { PAGE_SIZE } from "@/lib/catalog";
import { cleanCustomerSearch } from "@/lib/customers";

/** Same character filter as the customer search. */
export const cleanSupplierSearch = cleanCustomerSearch;

const row = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  vat_number: z.string().nullable(),
  created_at: z.string(),
});

/** One page of suppliers A-Z (archived ones are left out). Managers and owners only (RLS). */
export async function listSuppliers(orgId: string, q: string, page: number) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("suppliers")
    .select("id, name, email, phone, vat_number, created_at", { count: "exact" })
    .eq("org_id", orgId)
    .is("archived_at", null)
    .order("name")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
  const { data, error, count } = await query;
  if (error) throw new Error("Could not load suppliers");
  return { rows: z.array(row).parse(data ?? []), total: count ?? 0 };
}
