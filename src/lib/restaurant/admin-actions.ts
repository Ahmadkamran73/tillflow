"use server";

import { redirect } from "next/navigation";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { parseDiscountLimit } from "@/lib/device/discount-limit";
import { logger } from "@/lib/logger";
import { hasDuplicateNames, hasOverlap, planSchema } from "./floor-plan";
import { MAX_SERVICE_CHARGE_BP } from "@/lib/money";

// Back-office actions for table service. Each checks the caller's role, validates its input with
// Zod, then calls a SECURITY DEFINER function that checks the role again and writes the audit row.

const uuid = z.uuid();

export type SaveFloorPlanResult =
  { ok: true } | { ok: false; error: "invalid" | "overlap" | "failed" };

/** Saves the whole floor plan (managers and owners). Anything left out is archived, never deleted. */
export async function saveFloorPlanAction(
  orgId: string,
  rawPlan: unknown,
): Promise<SaveFloorPlanResult> {
  const id = uuid.safeParse(orgId);
  if (!id.success) redirect("/o");
  await requireRole(["owner", "manager"], id.data);

  const plan = planSchema.safeParse(rawPlan);
  if (!plan.success || hasDuplicateNames(plan.data)) return { ok: false, error: "invalid" };
  if (hasOverlap(plan.data)) return { ok: false, error: "overlap" };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("save_floor_plan", {
    p_org: id.data,
    p_floors: plan.data,
  });
  if (error) {
    logger.error({ code: error.code }, "save_floor_plan failed");
    return { ok: false, error: error.code === "22023" ? "overlap" : "failed" };
  }
  return { ok: true };
}

/** The service charge (percent, from the form) as basis points, owners only. */
export async function setServiceChargeAction(formData: FormData): Promise<void> {
  const raw = formData.get("orgId");
  const orgId = uuid.safeParse(typeof raw === "string" ? raw : "");
  if (!orgId.success) redirect("/o");
  await requireRole("owner", orgId.data);
  const page = `/o/${orgId.data}/settings/service-charge`;

  const percent = formData.get("percent");
  const bp = parseDiscountLimit(typeof percent === "string" ? percent : "");
  if (bp === null || bp > MAX_SERVICE_CHARGE_BP) redirect(`${page}?result=invalid`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_service_charge", {
    p_org: orgId.data,
    p_bp: bp,
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "set_service_charge failed");
    redirect(`${page}?result=error`);
  }
  redirect(`${page}?result=saved`);
}
