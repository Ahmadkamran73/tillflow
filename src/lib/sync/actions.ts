"use server";

import { redirect } from "next/navigation";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { syncSale } from "./protocol";
import { syncSalesFromSession } from "./server";

const str = (formData: FormData, key: string) => {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
};

const input = z.object({ orgId: z.uuid(), id: z.uuid() });
const page = (orgId: string) => `/o/${orgId}/sales/attention`;

/**
 * "Try again": runs the rejected sale through the same server check as sync, as its original
 * cashier. It is recorded only if it now passes (an unknown item restored, a receipt number freed);
 * the server's rules are not bypassed. A sale that passes is closed on this list.
 */
export async function retryRejectedSaleAction(formData: FormData): Promise<void> {
  const parsed = input.safeParse({ orgId: str(formData, "orgId"), id: str(formData, "id") });
  if (!parsed.success) redirect("/o");
  const { orgId, id } = parsed.data;
  const { user } = await requireRole(["owner", "manager"], orgId);

  const supabase = await createSupabaseServerClient();
  const { data: row } = await supabase
    .from("sync_rejections")
    .select("id, register_id, reason, payload, status")
    .eq("org_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (!row || row.status !== "open" || !row.register_id) redirect(`${page(orgId)}?result=error`);

  // The stored sale carries its cashier. A sale held for a discount above the limit is approved by
  // the manager pressing the button (their session, checked above): the approval the till could not
  // get. Any approval id the till attached is dropped: it was not accepted, and may be forged.
  const { approvalId: _dropped, ...sale } = (row.payload ?? {}) as Record<string, unknown>;
  void _dropped;
  if (!syncSale.safeParse(sale).success) redirect(`${page(orgId)}?result=failed`);
  const approverUserId = row.reason === "discount_needs_approval" ? user.id : undefined;

  let ok = false;
  try {
    const [result] = await syncSalesFromSession([sale], {
      orgId,
      registerId: row.register_id,
      approverUserId,
    });
    ok = result?.status === "created" || result?.status === "duplicate";
  } catch (e) {
    logger.error({ name: e instanceof Error ? e.name : "Error" }, "retry of rejected sale failed");
  }
  if (!ok) redirect(`${page(orgId)}?result=failed`);

  const { error } = await supabase.rpc("resolve_sync_rejection", {
    p_id: id,
    p_note: "Recorded after trying again",
    p_audit_id: uuidv7(),
  });
  redirect(`${page(orgId)}?result=${error ? "error" : "retried"}`);
}

/** "Mark resolved": a manager closes the item with a note about what they did. Audit-logged. */
export async function resolveRejectedSaleAction(formData: FormData): Promise<void> {
  const parsed = input.safeParse({ orgId: str(formData, "orgId"), id: str(formData, "id") });
  if (!parsed.success) redirect("/o");
  const { orgId, id } = parsed.data;
  await requireRole(["owner", "manager"], orgId);

  const note = str(formData, "note").trim();
  if (note.length < 1 || note.length > 500) redirect(`${page(orgId)}?result=note`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("resolve_sync_rejection", {
    p_id: id,
    p_note: note,
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "resolve_sync_rejection failed");
    redirect(`${page(orgId)}?result=error`);
  }
  redirect(`${page(orgId)}?result=resolved`);
}

const reviewInput = z.object({
  orgId: z.uuid(),
  id: z.uuid(),
  note: z.string().trim().max(500),
});

/** A manager has looked at a flagged sale. The sale stays as it is; the review is an audit row. */
export async function markSaleReviewedAction(formData: FormData): Promise<void> {
  const parsed = reviewInput.safeParse({
    orgId: str(formData, "orgId"),
    id: str(formData, "id"),
    note: str(formData, "note"),
  });
  if (!parsed.success) redirect("/o");
  const { orgId, id, note } = parsed.data;
  await requireRole(["owner", "manager"], orgId);
  const review = `/o/${orgId}/sales/review`;

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("mark_sale_reviewed", {
    p_sale: id,
    p_note: note,
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "mark_sale_reviewed failed");
    redirect(`${review}?result=error&n=${Date.now()}`);
  }
  redirect(`${review}?result=reviewed&n=${Date.now()}`);
}
