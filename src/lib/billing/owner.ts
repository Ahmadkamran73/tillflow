import "server-only";
import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth";
import { dublinDate } from "./period";

/**
 * What the owner's Billing page shows. Everything is read through the owner's own session, so RLS
 * (owners of this business only) is what limits it; nothing here uses a privileged connection.
 */
const sub = z.object({
  status: z.enum(["trial", "active", "overdue", "paused"]),
  period_start: z.string().nullable(),
  period_end: z.string().nullable(),
});

const invoice = z.object({
  id: z.uuid(),
  invoice_no: z.number().int(),
  period_start: z.string(),
  period_end: z.string(),
  total_cents: z.number().int(),
  due_on: z.string(),
  payment_reference: z.string(),
  status: z.enum(["issued", "paid", "void"]),
  paid_on: z.string().nullable(),
});
export type OwnerInvoice = z.infer<typeof invoice>;

export type BillingOverview = {
  status: z.infer<typeof sub>["status"] | null;
  paidThrough: string | null;
  trialEndsOn: string | null;
  invoices: OwnerInvoice[];
  /** The newest invoice still waiting for payment, if any. */
  outstanding: OwnerInvoice | null;
};

export async function getBillingOverview(orgId: string): Promise<BillingOverview> {
  const supabase = await createSupabaseServerClient();
  const [s, i, o] = await Promise.all([
    supabase
      .from("subscriptions")
      .select("status, period_start, period_end")
      .eq("org_id", orgId)
      .maybeSingle(),
    supabase
      .from("billing_invoices")
      .select(
        "id, invoice_no, period_start, period_end, total_cents, due_on, payment_reference, status, paid_on",
      )
      .eq("org_id", orgId)
      .order("invoice_no", { ascending: false })
      .limit(60),
    supabase.from("organisations").select("trial_ends_at").eq("id", orgId).maybeSingle(),
  ]);
  if (s.error || i.error || o.error) throw new Error("Could not load billing");
  const subscription = s.data ? sub.parse(s.data) : null;
  const invoices = z.array(invoice).parse(i.data ?? []);
  const trialEnd = (o.data as { trial_ends_at: string | null } | null)?.trial_ends_at ?? null;
  return {
    status: subscription?.status ?? null,
    paidThrough: subscription?.period_end ?? null,
    trialEndsOn: trialEnd ? dublinDate(new Date(trialEnd)) : null,
    invoices,
    outstanding: invoices.find((x) => x.status === "issued") ?? null,
  };
}

/** One invoice for the PDF route; null when it is not this business's (RLS returns no row). */
export async function getOwnerInvoice(orgId: string, invoiceId: string) {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("billing_invoices")
    .select(
      "id, invoice_no, period_start, period_end, amount_ex_vat_cents, vat_rate_bp, vat_cents, total_cents, issued_at, due_on, payment_reference, status, supplier_name, supplier_address, supplier_vat_number, customer_name, customer_address, customer_vat_number",
    )
    .eq("org_id", orgId)
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw new Error("Could not load the invoice");
  return data
    ? z
        .object({
          id: z.uuid(),
          invoice_no: z.number().int(),
          period_start: z.string(),
          period_end: z.string(),
          amount_ex_vat_cents: z.number().int(),
          vat_rate_bp: z.number().int(),
          vat_cents: z.number().int(),
          total_cents: z.number().int(),
          issued_at: z.string(),
          due_on: z.string(),
          payment_reference: z.string(),
          status: z.enum(["issued", "paid", "void"]),
          supplier_name: z.string(),
          supplier_address: z.string(),
          supplier_vat_number: z.string(),
          customer_name: z.string(),
          customer_address: z.string().nullable(),
          customer_vat_number: z.string().nullable(),
        })
        .parse(data)
    : null;
}

/** Whether the business is overdue or paused, for the banner shown on every back-office page. */
export async function getBillingBanner(orgId: string): Promise<"paused" | "overdue" | null> {
  const supabase = await createSupabaseServerClient();
  // The business status is readable by every member (managers need to know why writes are refused);
  // "overdue" lives on the subscription, which only owners can read.
  const { data: org } = await supabase
    .from("organisations")
    .select("status")
    .eq("id", orgId)
    .maybeSingle();
  if ((org as { status?: string } | null)?.status === "read_only") return "paused";
  const { data } = await supabase
    .from("subscriptions")
    .select("status")
    .eq("org_id", orgId)
    .maybeSingle();
  return (data as { status?: string } | null)?.status === "overdue" ? "overdue" : null;
}
