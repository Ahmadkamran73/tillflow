import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { t } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const body = z.object({ orgId: z.uuid() });

/** POST /api/v1/imports/<id>/undo: within 24 hours of finishing. Audit-logged by the function. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !z.uuid().safeParse(id).success) {
    return new Response(null, { status: 400 });
  }
  const auth = await authorizeApi(["owner", "manager"], parsed.data.orgId);
  if (!auth.ok) return new Response(null, { status: auth.status });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("undo_import", {
    p_org: parsed.data.orgId,
    p_id: id,
  });
  if (error) {
    if (error.message.includes("import_undo_expired")) {
      return Response.json({ error: t("import.err.undoExpired") }, { status: 409 });
    }
    if (error.code === "22023") return new Response(null, { status: 404 });
    if (error.code === "42501") return new Response(null, { status: 403 });
    await reportError(error, { source: "server", route: "imports-undo" });
    return Response.json({ error: t("import.err.generic") }, { status: 503 });
  }
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
