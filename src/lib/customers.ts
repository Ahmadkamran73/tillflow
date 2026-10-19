import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth";
import { PAGE_SIZE } from "@/lib/catalog";

/** Keeps letters, digits and the few marks that appear in names, emails and phones. */
export const cleanCustomerSearch = (q: string | undefined) =>
  (q ?? "")
    .replace(/[^\p{L}\p{N} '&.@+-]/gu, "")
    .trim()
    .slice(0, 60);

const row = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  vat_number: z.string().nullable(),
  marketing_consent_at: z.string().nullable(),
  created_at: z.string(),
  anonymised_at: z.string().nullable(),
});

/** One page of customers, newest names first A-Z. Managers and owners only (RLS). */
export async function listCustomers(orgId: string, q: string, page: number) {
  const supabase = await createSupabaseServerClient();
  let query = supabase
    .from("customers")
    .select("id, name, email, phone, vat_number, marketing_consent_at, created_at, anonymised_at", {
      count: "exact",
    })
    .eq("org_id", orgId)
    .order("name")
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (q) query = query.or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`);
  const { data, error, count } = await query;
  if (error) throw new Error("Could not load customers");
  return { rows: z.array(row).parse(data ?? []), total: count ?? 0 };
}

const full = row.extend({ address: z.string().nullable(), notes: z.string().nullable() });

export async function getCustomer(orgId: string, id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("customers")
    .select(
      "id, name, email, phone, vat_number, marketing_consent_at, created_at, anonymised_at, address, notes",
    )
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  return data ? full.parse(data) : null;
}

const sale = z.object({
  id: z.string(),
  receipt_seq: z.number(),
  completed_at: z.string(),
  amount_due_cents: z.number(),
});

/** The latest 100 sales rung up for this customer (two reads: no embedded join to depend on). */
export async function customerPurchases(orgId: string, id: string) {
  const supabase = await createSupabaseServerClient();
  const links = await supabase
    .from("sale_customers")
    .select("sale_id")
    .eq("org_id", orgId)
    .eq("customer_id", id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (links.error) throw new Error("Could not load purchases");
  const ids = (links.data ?? []).map((l) => String(l.sale_id));
  if (ids.length === 0) return [];
  const sales = await supabase
    .from("sales")
    .select("id, receipt_seq, completed_at, amount_due_cents")
    .eq("org_id", orgId)
    .in("id", ids)
    .order("completed_at", { ascending: false });
  if (sales.error) throw new Error("Could not load purchases");
  return z.array(sale).parse(sales.data ?? []);
}
