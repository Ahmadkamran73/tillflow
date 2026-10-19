"use server";

import { redirect } from "next/navigation";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { logger } from "@/lib/logger";

// Settings > Payment types. A manager adds, renames and archives the location's card
// types. Cash is built in. Role checked here, input validated with Zod, and the database checks
// again (RLS: managers only; a trigger refuses archiving cash). Never deleted: payments point at them.

const str = (formData: FormData, key: string) => {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
};

const label = z.string().trim().min(1).max(40);

const page = (orgId: string) => `/o/${orgId}/settings/tenders`;

export async function addTenderTypeAction(formData: FormData): Promise<void> {
  const orgId = z.uuid().safeParse(str(formData, "orgId"));
  if (!orgId.success) redirect("/o");
  await requireRole(["owner", "manager"], orgId.data);
  const name = label.safeParse(str(formData, "label"));
  const method = z.enum(["card"]).safeParse(str(formData, "method"));
  if (!name.success || !method.success) redirect(`${page(orgId.data)}?result=invalid`);
  const location = await getLocation(orgId.data);
  if (!location) redirect(`${page(orgId.data)}?result=error`);

  const supabase = await createSupabaseServerClient();
  const { data: last } = await supabase
    .from("tender_types")
    .select("sort")
    .eq("org_id", orgId.data)
    .eq("location_id", location.id)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();
  const { error } = await supabase.from("tender_types").insert({
    id: uuidv7(),
    org_id: orgId.data,
    location_id: location.id,
    method: method.data,
    label: name.data,
    sort: ((last?.sort as number | undefined) ?? 0) + 10,
  });
  if (error) {
    logger.error({ code: error.code }, "add tender type failed");
    redirect(`${page(orgId.data)}?result=error`);
  }
  redirect(`${page(orgId.data)}?result=saved`);
}

export async function renameTenderTypeAction(formData: FormData): Promise<void> {
  const orgId = z.uuid().safeParse(str(formData, "orgId"));
  const id = z.uuid().safeParse(str(formData, "id"));
  if (!orgId.success || !id.success) redirect("/o");
  await requireRole(["owner", "manager"], orgId.data);
  const name = label.safeParse(str(formData, "label"));
  if (!name.success) redirect(`${page(orgId.data)}?result=invalid`);

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("tender_types")
    .update({ label: name.data })
    .eq("org_id", orgId.data)
    .eq("id", id.data);
  if (error) {
    logger.error({ code: error.code }, "rename tender type failed");
    redirect(`${page(orgId.data)}?result=error`);
  }
  redirect(`${page(orgId.data)}?result=saved`);
}

/** Takes a type off the till, or puts it back (`restore=1`). Cash cannot be archived (trigger). */
export async function archiveTenderTypeAction(formData: FormData): Promise<void> {
  const orgId = z.uuid().safeParse(str(formData, "orgId"));
  const id = z.uuid().safeParse(str(formData, "id"));
  if (!orgId.success || !id.success) redirect("/o");
  await requireRole(["owner", "manager"], orgId.data);
  const restore = str(formData, "restore") === "1";

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("tender_types")
    .update({ archived_at: restore ? null : new Date().toISOString() })
    .eq("org_id", orgId.data)
    .eq("id", id.data);
  if (error) {
    logger.error({ code: error.code }, "archive tender type failed");
    redirect(`${page(orgId.data)}?result=error`);
  }
  redirect(`${page(orgId.data)}?result=saved`);
}
