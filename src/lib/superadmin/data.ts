import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Reads for the superadmin console, all through admin_* database functions (which check the
 * superadmin again and audit per-business reads). Callers must already have passed
 * requireSuperadmin(). Every result is parsed with Zod; an unexpected shape throws.
 */
const ts = z.string().nullable();

export const orgRow = z.object({
  id: z.uuid(),
  name: z.string(),
  org_status: z.string(),
  created_at: z.string(),
  trial_ends_at: ts,
  billing_status: z.string().nullable(),
  last_payment_at: ts,
  last_sync_at: ts,
  tills: z.number().int(),
});
export type OrgRow = z.infer<typeof orgRow>;

export const usage = z.object({
  org_id: z.uuid(),
  name: z.string(),
  org_status: z.string(),
  billing_status: z.string().nullable(),
  trial_ends_at: ts,
  business_type: z.string().nullable(),
  created_at: z.string(),
  sales_7d: z.number().int(),
  sales_30d: z.number().int(),
  products: z.number().int(),
  staff: z.number().int(),
  tills: z.number().int(),
  tills_last_seen: ts,
  last_sale_at: ts,
  open_attention: z.number().int(),
  open_invoices: z.number().int(),
  last_payment_at: ts,
});

async function call<T>(
  fn: string,
  args: Record<string, unknown>,
  schema: z.ZodType<T>,
  userId: string,
): Promise<T> {
  const limit = await rateLimit("superadmin", userId);
  if (!limit.allowed) throw new Error("superadmin rate limit");
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc(fn, args);
  // Only the SQLSTATE: a database message must never carry business data into logs.
  if (error) throw new Error(`${fn} failed: ${error.code}`);
  return schema.parse(data);
}

export const PAGE_SIZE = 25;

export const listOrgs = (userId: string, search: string, page: number) =>
  call(
    "admin_list_orgs",
    { p_search: search, p_limit: PAGE_SIZE + 1, p_offset: page * PAGE_SIZE },
    z.array(orgRow),
    userId,
  );

export const orgName = (userId: string, orgId: string) =>
  call("admin_org_name", { p_org: orgId }, z.string(), userId);

export const orgUsage = (userId: string, orgId: string) =>
  call("admin_org_usage", { p_org: orgId }, usage, userId);

const dashboard = z.object({
  name: z.string(),
  business_type: z.string().nullable(),
  org_status: z.string(),
  sales_today: z.number().int(),
  takings_today_cents: z.number().int(),
  sales_7d: z.number().int(),
  takings_7d_cents: z.number().int(),
  open_attention: z.number().int(),
  to_review: z.number().int(),
});
export const viewDashboard = (userId: string, orgId: string) =>
  call("admin_view_dashboard", { p_org: orgId }, dashboard, userId);

const saleRow = z.object({
  id: z.uuid(),
  receipt_seq: z.number().int(),
  till: z.string(),
  completed_at: z.string(),
  amount_due_cents: z.number().int(),
  vat_cents: z.number().int(),
  review_flags: z.array(z.string()),
});
export const viewSales = (userId: string, orgId: string, before: string | null) =>
  call(
    "admin_view_sales",
    { p_org: orgId, p_limit: PAGE_SIZE, p_before: before },
    z.array(saleRow),
    userId,
  );

const productRow = z.object({
  id: z.uuid(),
  name: z.string(),
  tax_category: z.string(),
  track_stock: z.boolean(),
  price_from_cents: z.number().int().nullable(),
  variants: z.number().int(),
});
export const viewProducts = (userId: string, orgId: string, page: number) =>
  call(
    "admin_view_products",
    { p_org: orgId, p_limit: PAGE_SIZE + 1, p_offset: page * PAGE_SIZE },
    z.array(productRow),
    userId,
  );

const staffRow = z.object({
  display_name: z.string().nullable(),
  role: z.string(),
  till_only: z.boolean(),
});
export const viewStaff = (userId: string, orgId: string) =>
  call("admin_view_staff", { p_org: orgId }, z.array(staffRow), userId);

const shiftRow = z.object({
  id: z.uuid(),
  till: z.string(),
  opened_at: z.string(),
  float_cents: z.number().int(),
  z_seq: z.number().int().nullable(),
  closed_at: ts,
  counted_cents: z.number().int().nullable(),
  expected_cents: z.number().int().nullable(),
  over_short_cents: z.number().int().nullable(),
});
export const viewShifts = (userId: string, orgId: string) =>
  call("admin_view_shifts", { p_org: orgId, p_limit: 50 }, z.array(shiftRow), userId);
