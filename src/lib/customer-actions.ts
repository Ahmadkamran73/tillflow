"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import type { FormState } from "@/lib/auth/schemas";
import { customerFields, toDbCustomer } from "@/lib/customer-schema";
import { t } from "@/lib/i18n";
import { logger } from "@/lib/logger";
import { v7 as uuidv7 } from "uuid";

const str = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" ? v : "";
};

const ids = z.object({ orgId: z.uuid(), customerId: z.uuid().optional() });

/** Create (no customerId) or edit a customer through public.save_customer. */
export async function saveCustomerAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const key = ids.safeParse({
    orgId: str(formData, "orgId"),
    customerId: str(formData, "customerId") || undefined,
  });
  if (!key.success) return { error: t("customers.err.generic") };
  const parsed = customerFields.safeParse({
    name: str(formData, "name"),
    email: str(formData, "email"),
    phone: str(formData, "phone"),
    vatNumber: str(formData, "vatNumber"),
    address: str(formData, "address"),
    notes: str(formData, "notes"),
  });
  if (!parsed.success) {
    const bad = (k: string) => parsed.error.issues.some((i) => i.path[0] === k);
    const fieldErrors: Record<string, string[]> = {};
    if (bad("name")) fieldErrors.name = [t("customers.err.name")];
    if (bad("email")) fieldErrors.email = [t("customers.err.email")];
    if (bad("vatNumber")) fieldErrors.vatNumber = [t("customers.err.vat")];
    for (const k of ["phone", "address", "notes"])
      if (bad(k)) fieldErrors[k] = [t("customers.err.long")];
    return { fieldErrors };
  }
  await requireRole(["owner", "manager"], key.data.orgId);

  const id = key.data.customerId ?? uuidv7();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("save_customer", {
    p_org: key.data.orgId,
    p_id: id,
    p: toDbCustomer(parsed.data),
  });
  if (error) {
    logger.error({ code: error.code }, "save_customer failed");
    return error.code === "23505"
      ? { fieldErrors: { email: [t("customers.err.emailTaken")] } }
      : { error: t("customers.err.generic") };
  }
  redirect(`/o/${key.data.orgId}/customers/${id}?saved=1`);
}

/** Record or withdraw marketing consent (the timestamp is the database's clock). */
export async function setConsentAction(formData: FormData): Promise<void> {
  const key = ids.extend({ customerId: z.uuid(), on: z.enum(["1", "0"]) }).safeParse({
    orgId: str(formData, "orgId"),
    customerId: str(formData, "customerId"),
    on: str(formData, "on"),
  });
  if (!key.success) redirect("/o");
  await requireRole(["owner", "manager"], key.data.orgId);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("set_marketing_consent", {
    p_org: key.data.orgId,
    p_id: key.data.customerId,
    p_on: key.data.on === "1",
  });
  if (error) logger.error({ code: error.code }, "set_marketing_consent failed");
  redirect(
    `/o/${key.data.orgId}/customers/${key.data.customerId}?${error ? "error=1" : "saved=1"}`,
  );
}

/** GDPR erasure: scrub the personal data, keep the id and the sale links. */
export async function anonymiseCustomerAction(formData: FormData): Promise<void> {
  const key = ids.extend({ customerId: z.uuid() }).safeParse({
    orgId: str(formData, "orgId"),
    customerId: str(formData, "customerId"),
  });
  if (!key.success) redirect("/o");
  await requireRole(["owner", "manager"], key.data.orgId);
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("anonymise_customer", {
    p_org: key.data.orgId,
    p_id: key.data.customerId,
  });
  if (error) logger.error({ code: error.code }, "anonymise_customer failed");
  redirect(
    `/o/${key.data.orgId}/customers/${key.data.customerId}?${error ? "error=1" : "erased=1"}`,
  );
}
