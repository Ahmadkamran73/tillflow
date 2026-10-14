"use server";

import { redirect } from "next/navigation";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { enqueue } from "@/lib/jobs";

/**
 * Owners ask for the whole-account export. The database checks owner and "one a day" again and
 * writes the audit row; the work itself happens in the `account-export` background job.
 */
export async function requestAccountExportAction(formData: FormData): Promise<void> {
  const raw = formData.get("orgId");
  const orgId = z.uuid().safeParse(typeof raw === "string" ? raw : "");
  if (!orgId.success) redirect("/o");
  await requireRole("owner", orgId.data);
  const page = `/o/${orgId.data}/settings/export`;

  const id = uuidv7();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("request_account_export", { p_org: orgId.data, p_id: id });
  if (error) {
    if (error.code === "TF002") redirect(`${page}?result=limit`);
    // The sign-in proof is older than 10 minutes: confirm again, then come back here.
    if (error.code === "TF003") redirect(`${page}/confirm?next=${encodeURIComponent(page)}`);
    await reportError(error, { source: "server", route: "account-export" });
    redirect(`${page}?result=error`);
  }
  try {
    await enqueue("account-export", { export_id: id });
  } catch (e) {
    // The row stays queued; the database lets the owner ask again after 15 minutes.
    await reportError(e, { source: "server", route: "account-export" });
    redirect(`${page}?result=error`);
  }
  redirect(`${page}?result=requested`);
}
