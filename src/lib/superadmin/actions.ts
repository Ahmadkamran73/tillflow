"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createSupabaseServerClient, requireSuperadmin } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";

/**
 * Superadmin actions on one business. Each one proves the caller is the superadmin (IP allowlist,
 * platform_admins row, two-step session), is rate limited, validates with Zod, then calls a database
 * function that checks the same things again and writes the audit row. The reason note is required.
 */
const orgId = z.uuid();
const note = z.string().trim().min(5).max(300);

const page = (id: string) => `/superadmin/orgs/${id}`;
const back = (id: string, result: string): never => redirect(`${page(id)}?result=${result}`);

async function guard(id: unknown): Promise<string> {
  const parsed = orgId.safeParse(id);
  // A malformed id is a 404-style dead end, not an error page that confirms anything.
  if (!parsed.success) redirect("/superadmin");
  const { user } = await requireSuperadmin(page(parsed.data));
  const limit = await rateLimit("superadmin", user.id);
  if (!limit.allowed) return back(parsed.data, "error");
  return parsed.data;
}

/** Only the SQLSTATE is reported: a database message can echo the note. */
async function fail(id: string, fn: string, code: string | undefined): Promise<never> {
  if (code !== "22023" && code !== "42501") {
    await reportError(new Error(`${fn} failed: ${code}`), {
      source: "server",
      route: "superadmin",
    });
  }
  return back(id, "error");
}

export async function extendTrialAction(formData: FormData): Promise<void> {
  const id = await guard(formData.get("orgId"));
  const parsed = z
    .object({ days: z.coerce.number().int().min(1).max(90), note })
    .safeParse({ days: formData.get("days"), note: formData.get("note") });
  if (!parsed.success) return back(id, "error");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("admin_extend_trial", {
    p_org: id,
    p_days: parsed.data.days,
    p_note: parsed.data.note,
  });
  if (error) return fail(id, "admin_extend_trial", error.code);
  return back(id, "extended");
}

export async function pauseOrganisationAction(formData: FormData): Promise<void> {
  const id = await guard(formData.get("orgId"));
  const parsed = z.object({ note }).safeParse({ note: formData.get("note") });
  if (!parsed.success) return back(id, "error");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("admin_pause", { p_org: id, p_note: parsed.data.note });
  if (error) return fail(id, "admin_pause", error.code);
  return back(id, "paused");
}

export async function unpauseFromOrgAction(formData: FormData): Promise<void> {
  const id = await guard(formData.get("orgId"));
  const parsed = z
    .object({ note, holdDays: z.coerce.number().int().min(0).max(365) })
    .safeParse({ note: formData.get("note"), holdDays: formData.get("holdDays") });
  if (!parsed.success) return back(id, "error");
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("admin_unpause", {
    p_org: id,
    p_note: parsed.data.note,
    p_hold_days: parsed.data.holdDays,
  });
  if (error) return fail(id, "admin_unpause", error.code);
  return back(id, "unpaused");
}
