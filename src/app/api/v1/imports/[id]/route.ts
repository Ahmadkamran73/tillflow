import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** GET /api/v1/imports/<id>?orgId=: progress and result (managers and owners, through RLS). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const orgId = z.uuid().safeParse(request.nextUrl.searchParams.get("orgId"));
  if (!orgId.success || !z.uuid().safeParse(id).success) {
    return new Response(null, { status: 404 });
  }
  const auth = await authorizeApi(["owner", "manager"], orgId.data);
  if (!auth.ok) return new Response(null, { status: auth.status });

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("import_jobs")
    .select(
      "id, status, mode, file_name, total_rows, processed_rows, created_count, updated_count, skipped_count, error_count, errors, failure, finished_at, undo_until, undone_at",
    )
    .eq("org_id", orgId.data)
    .eq("id", id)
    .maybeSingle();
  if (!data) return new Response(null, { status: 404 });
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
