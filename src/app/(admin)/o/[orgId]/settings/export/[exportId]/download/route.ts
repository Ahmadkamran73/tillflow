import type { NextRequest } from "next/server";
import { z } from "zod";
import { appRedirect, authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const CHUNK = 2 * 1024 * 1024; // the most get_account_export_chunk returns per call

/**
 * GET /o/<orgId>/settings/export/<id>/download: the finished ZIP. Owner only (signed in, with
 * two-step verification where they have it), 5 per hour per user; the database checks the shop,
 * the status and the 7-day expiry again and writes an audit row for every download.
 */
export async function GET(
  _request: NextRequest,
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
  // The file is read in slices: one call for a big ZIP hits the database's statement timeout.
  const { data: info } = await supabase
    .from("account_exports")
    .select("size_bytes")
    .eq("org_id", orgId)
    .eq("id", exportId)
    .maybeSingle();
  const size = Number(info?.size_bytes ?? 0);
  if (!Number.isSafeInteger(size) || size < 1) return new Response(null, { status: 404 });

  const slice = (offset: number) =>
    supabase.rpc("get_account_export_chunk", {
      p_org: orgId,
      p_id: exportId,
      p_offset: offset,
      p_length: CHUNK,
    });
  const toBytes = (data: unknown) => {
    const hex = typeof data === "string" ? (data.startsWith("\\x") ? data.slice(2) : data) : null;
    return hex === null ? null : new Uint8Array(Buffer.from(hex, "hex"));
  };

  // The first slice is fetched before answering, so refusals still get a proper status.
  const first = await slice(0);
  if (first.error?.code === "TF003") {
    // The sign-in proof is older than 10 minutes: confirm again, then come back to the list.
    const page = `/o/${orgId}/settings/export`;
    return appRedirect(`${page}/confirm?next=${encodeURIComponent(page)}`);
  }
  const head = first.error ? null : toBytes(first.data);
  if (first.error || !head) {
    if (first.error && first.error.code !== "22023") {
      await reportError(first.error, { source: "server", route: "account-export-download" });
    }
    return new Response(null, { status: first.error && first.error.code !== "22023" ? 503 : 404 });
  }

  let offset = head.length;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(head);
    },
    async pull(controller) {
      if (offset >= size) return controller.close();
      const next = await slice(offset);
      const bytes = next.error ? null : toBytes(next.data);
      if (!bytes || bytes.length === 0) {
        if (next.error)
          await reportError(next.error, { source: "server", route: "account-export-download" });
        return controller.error(new Error("export slice unavailable"));
      }
      offset += bytes.length;
      controller.enqueue(bytes);
      if (offset >= size) controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(size),
      "Content-Disposition": `attachment; filename="tillflow-data-${exportId.slice(0, 8)}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
