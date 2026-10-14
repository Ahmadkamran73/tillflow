import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * GET /o/<orgId>/settings/export/<id>/download: the finished ZIP. Owner only (signed in, with
 * two-step verification where they have it), 5 per hour per user; the database checks the shop,
 * the status and the 7-day expiry again and writes an audit row for every download.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; exportId: string }> },
) {
  const { orgId, exportId } = await params;
  const auth = await authorizeApi("owner", orgId);
  if (!auth.ok) return new Response(null, { status: auth.status });
  if (!z.uuid().safeParse(exportId).success) return new Response(null, { status: 404 });

  const limit = await rateLimit("export", auth.user.id);
  if (!limit.allowed) {
    return new Response(null, {
      status: 429,
      headers: { "Retry-After": String(limit.retryAfterSeconds) },
    });
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_account_export", {
    p_org: orgId,
    p_id: exportId,
  });
  if (error?.code === "TF003") {
    // The sign-in proof is older than 10 minutes: confirm again, then come back to the list.
    const page = `/o/${orgId}/settings/export`;
    return Response.redirect(
      new URL(`${page}/confirm?next=${encodeURIComponent(page)}`, request.url),
      303,
    );
  }
  if (error || typeof data !== "string") {
    if (error && error.code !== "22023") {
      await reportError(error, { source: "server", route: "account-export-download" });
    }
    return new Response(null, { status: error && error.code !== "22023" ? 503 : 404 });
  }
  const bytes = Buffer.from(data.startsWith("\\x") ? data.slice(2) : data, "hex");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="tillflow-data-${exportId.slice(0, 8)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
