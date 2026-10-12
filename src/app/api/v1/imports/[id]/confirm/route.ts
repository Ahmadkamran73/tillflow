import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { REQUIRED } from "@/lib/import/fields";
import { settingsSchema } from "@/lib/import/server";
import { enqueue } from "@/lib/jobs";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const body = settingsSchema.extend({ orgId: z.uuid() });

/**
 * POST /api/v1/imports/<id>/confirm: saves the settings and queues the background job. The job
 * validates the file again itself, so nothing the browser says about the preview is trusted.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.uuid().safeParse(id).success) {
    return new Response(null, { status: 400 });
  }
  const { orgId, ...settings } = parsed.data;
  const auth = await authorizeApi(["owner", "manager"], orgId);
  if (!auth.ok) return new Response(null, { status: auth.status });
  if (REQUIRED.some((f) => !settings.mapping[f])) {
    return json({ error: t("import.err.required") }, 400);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("confirm_import", {
    p_org: orgId,
    p_id: id,
    p_mode: settings.mode,
    p_match_key: settings.matchKey,
    p_mapping: settings.mapping,
  });
  if (error) {
    if (error.code === "22023") return new Response(null, { status: 404 });
    if (error.code === "42501") return new Response(null, { status: 403 });
    await reportError(error, { source: "server", route: "imports-confirm" });
    return json({ error: t("import.err.generic") }, 503);
  }
  try {
    await enqueue("import-products", { org_id: orgId, user_id: auth.user.id, import_id: id });
  } catch (e) {
    // Still "queued" in the database: pressing Start again tries once more.
    await reportError(e, { source: "server", route: "imports-confirm" });
    return json({ error: t("import.err.queue") }, 503);
  }
  return json({ ok: true }, 202);
}
