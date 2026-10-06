"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { hashPin, pinSchema } from "@/lib/auth/pin";
import { getLocation } from "@/lib/catalog";
import { logger } from "@/lib/logger";
import { parseDiscountLimit } from "./discount-limit";
import { formatPairingCode, generatePairingCode, hashPairingCode } from "./token";

// Back-office actions for tills, PINs and the discount limit. Each one checks the caller's role,
// validates its input, and then calls a SECURITY DEFINER function that checks the role again and
// writes the audit row. Nothing here ever logs a PIN, a code or a hash.

const str = (formData: FormData, key: string) => {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
};
const uuid = z.uuid();

export type PairingCodeResult = { ok: true; code: string; expiresAt: string } | { ok: false };

/** Makes a one-time code for a till. The code is returned once, to the manager's screen; only its hash is stored. */
export async function createPairingCodeAction(
  orgId: string,
  registerId: string,
): Promise<PairingCodeResult> {
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(registerId).success) return { ok: false };
  await requireRole(["owner", "manager"], orgId);
  const supabase = await createSupabaseServerClient();
  const code = generatePairingCode();
  const { data, error } = await supabase.rpc("create_pairing_code", {
    p_register: registerId,
    p_code_hash: hashPairingCode(code),
    p_audit_id: uuidv7(),
  });
  if (error || typeof data !== "string") {
    logger.error({ code: error?.code }, "create_pairing_code failed");
    return { ok: false };
  }
  revalidatePath(`/o/${orgId}/settings/tills`);
  return { ok: true, code: formatPairingCode(code), expiresAt: data };
}

/** Unpairs a till: its token stops working at once. */
export async function revokeRegisterAction(
  orgId: string,
  registerId: string,
): Promise<{ ok: boolean }> {
  if (!uuid.safeParse(orgId).success || !uuid.safeParse(registerId).success) return { ok: false };
  await requireRole(["owner", "manager"], orgId);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("revoke_register", {
    p_register: registerId,
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "revoke_register failed");
    return { ok: false };
  }
  revalidatePath(`/o/${orgId}/settings/tills`);
  return { ok: true };
}

const tillName = z.string().trim().min(1).max(80);

export async function addTillAction(formData: FormData): Promise<void> {
  const orgId = uuid.safeParse(str(formData, "orgId"));
  if (!orgId.success) redirect("/o");
  await requireRole(["owner", "manager"], orgId.data);
  const page = `/o/${orgId.data}/settings/tills`;

  const name = tillName.safeParse(str(formData, "name"));
  const location = await getLocation(orgId.data);
  if (!name.success || !location) redirect(`${page}?result=error`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("registers").insert({
    id: uuidv7(),
    org_id: orgId.data,
    location_id: location.id,
    name: name.data,
  });
  if (error) {
    if (error.code === "23505") redirect(`${page}?result=taken`);
    logger.error({ code: error.code }, "adding a till failed");
    redirect(`${page}?result=error`);
  }
  redirect(`${page}?result=added`);
}

const pinForm = z.object({
  name: z.string().trim().min(1).max(40),
  pin: pinSchema,
  confirm: z.string(),
});

/** The signed-in person sets their own till name and PIN. The PIN is hashed here; only the hash is stored. */
export async function savePinAction(formData: FormData): Promise<void> {
  const orgId = uuid.safeParse(str(formData, "orgId"));
  if (!orgId.success) redirect("/o");
  await requireRole(["owner", "manager"], orgId.data);
  const page = `/o/${orgId.data}/settings/pin`;

  const parsed = pinForm.safeParse({
    name: str(formData, "name"),
    pin: str(formData, "pin"),
    confirm: str(formData, "confirm"),
  });
  if (!parsed.success) redirect(`${page}?result=invalid`);
  if (parsed.data.pin !== parsed.data.confirm) redirect(`${page}?result=mismatch`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_my_pin_hash", {
    p_org: orgId.data,
    p_hash: await hashPin(parsed.data.pin),
    p_display_name: parsed.data.name,
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "set_my_pin_hash failed");
    redirect(`${page}?result=error`);
  }
  redirect(`${page}?result=saved`);
}

/** A manager clears a cashier's PIN (an owner can clear anyone's). */
export async function resetPinAction(formData: FormData): Promise<void> {
  const orgId = uuid.safeParse(str(formData, "orgId"));
  const membershipId = uuid.safeParse(str(formData, "membershipId"));
  if (!orgId.success) redirect("/o");
  await requireRole(["owner", "manager"], orgId.data);
  const page = `/o/${orgId.data}/staff`;
  if (!membershipId.success) redirect(`${page}?result=error`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("reset_member_pin", {
    p_membership: membershipId.data,
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "reset_member_pin failed");
    redirect(`${page}?result=error`);
  }
  redirect(`${page}?result=reset`);
}

export async function setDiscountLimitAction(formData: FormData): Promise<void> {
  const orgId = uuid.safeParse(str(formData, "orgId"));
  if (!orgId.success) redirect("/o");
  await requireRole("owner", orgId.data);
  const page = `/o/${orgId.data}/settings/discount-limit`;

  const bp = parseDiscountLimit(str(formData, "percent"));
  if (bp === null) redirect(`${page}?result=invalid`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_discount_override", {
    p_org: orgId.data,
    p_bp: bp,
    p_audit_id: uuidv7(),
  });
  if (error) {
    logger.error({ code: error.code }, "set_discount_override failed");
    redirect(`${page}?result=error`);
  }
  redirect(`${page}?result=saved`);
}
