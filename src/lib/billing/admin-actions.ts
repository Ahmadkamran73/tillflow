"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient, requireSuperadmin } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";
import {
  MAX_STATEMENT_BYTES,
  parseStatement,
  suggest,
  type InvoiceMatch,
  type Suggestion,
} from "./statement";

/**
 * Super-admin actions. Each one first proves the caller is a super-admin on a two-step session,
 * then calls a database function that checks it again and writes the audit row. Nothing here
 * changes a payment on its own: the statement matcher only suggests, a person presses Confirm.
 */
const PAGE = "/superadmin/billing";
const filterSchema = z.enum(["outstanding", "overdue", "paid"]).catch("outstanding");

const back = (filter: string, result: string): never =>
  redirect(`${PAGE}?filter=${filter}&result=${result}`);

const markPaid = z.object({
  invoiceId: z.uuid(),
  bankReference: z.string().trim().min(3).max(100),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function markInvoicePaidAction(formData: FormData): Promise<void> {
  await requireSuperadmin(PAGE);
  const filter = filterSchema.parse(formData.get("filter"));
  const parsed = markPaid.safeParse({
    invoiceId: formData.get("invoiceId"),
    bankReference: formData.get("bankReference"),
    paidOn: formData.get("paidOn"),
  });
  if (!parsed.success) return back(filter, "error");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("admin_mark_paid", {
    p_invoice: parsed.data.invoiceId,
    p_bank_reference: parsed.data.bankReference,
    p_paid_on: parsed.data.paidOn,
  });
  if (error) {
    // 22023: a value the database refuses (bad date, not outstanding); 42501: not an admin any more.
    // Only the code is reported: the database message can echo the bank reference.
    if (error.code !== "22023" && error.code !== "42501") {
      await reportError(new Error(`admin_mark_paid failed: ${error.code}`), {
        source: "server",
        route: "admin-billing",
      });
    }
    return back(filter, "error");
  }
  return back(filter, "paid");
}

const unpause = z.object({
  orgId: z.uuid(),
  note: z.string().trim().min(5).max(300),
  holdDays: z.coerce.number().int().min(0).max(365),
});

export async function unpauseOrganisationAction(formData: FormData): Promise<void> {
  await requireSuperadmin(PAGE);
  const filter = filterSchema.parse(formData.get("filter"));
  const parsed = unpause.safeParse({
    orgId: formData.get("orgId"),
    note: formData.get("note"),
    holdDays: formData.get("holdDays"),
  });
  if (!parsed.success) return back(filter, "error");

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("admin_unpause", {
    p_org: parsed.data.orgId,
    p_note: parsed.data.note,
    p_hold_days: parsed.data.holdDays,
  });
  if (error) {
    if (error.code !== "22023" && error.code !== "42501") {
      await reportError(new Error(`admin_unpause failed: ${error.code}`), {
        source: "server",
        route: "admin-billing",
      });
    }
    return back(filter, "error");
  }
  return back(filter, "unpaused");
}

export type StatementState =
  | { status: "idle" }
  | { status: "error"; reason: "bad" | "limit" }
  | { status: "done"; suggestions: Suggestion[]; rowsRead: number; truncated: boolean };

const invoiceMatch = z.array(
  z.object({
    reference: z.string(),
    invoice_id: z.uuid(),
    org_name: z.string(),
    invoice_no: z.number().int(),
    total_cents: z.number().int(),
    status: z.enum(["issued", "paid", "void"]),
    due_on: z.string(),
  }),
);

/** Reads an uploaded bank statement and suggests invoices. Parsed in memory; nothing is stored. */
export async function matchStatementAction(
  _prev: StatementState,
  formData: FormData,
): Promise<StatementState> {
  const { user } = await requireSuperadmin(PAGE);
  const limit = await rateLimit("billing-statement", user.id);
  if (!limit.allowed) return { status: "error", reason: "limit" };

  const file = formData.get("statement");
  if (!(file instanceof File) || file.size === 0 || file.size > MAX_STATEMENT_BYTES) {
    return { status: "error", reason: "bad" };
  }
  try {
    const parsed = parseStatement(await file.text());
    const refs = [...new Set(parsed.lines.flatMap((l) => l.references))];
    let found: InvoiceMatch[] = [];
    if (refs.length > 0) {
      const supabase = await createSupabaseServerClient();
      const { data, error } = await supabase.rpc("admin_match_references", {
        p_refs: refs.slice(0, 2000),
      });
      if (error) throw error;
      found = invoiceMatch.parse(data ?? []);
    }
    return {
      status: "done",
      suggestions: suggest(parsed.lines, found),
      rowsRead: parsed.rowsRead,
      truncated: parsed.truncated,
    };
  } catch {
    await reportError(new Error("statement matching failed"), {
      source: "server",
      route: "admin-billing-statement",
    });
    return { status: "error", reason: "bad" };
  }
}
