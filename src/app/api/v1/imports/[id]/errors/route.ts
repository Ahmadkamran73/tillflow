import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { errorsCsv } from "@/lib/import/errors-file";
import { ImportFileError } from "@/lib/import/parse";
import { analyse, settingsSchema } from "@/lib/import/server";
import { getOrganisation } from "@/lib/org";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const body = settingsSchema.extend({ orgId: z.uuid() });

/**
 * POST /api/v1/imports/<id>/errors: the rows that cannot be imported, as a CSV to fix and upload
 * again. Rebuilt from the stored file (kept 7 days) with the mapping the shop chose.
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
  const org = await getOrganisation(orgId);
  if (!org) return new Response(null, { status: 404 });
  // Same budget as the preview: this also re-reads the stored file.
  if (!(await rateLimit("import-reparse", orgId)).allowed) return new Response(null, { status: 429 });
  try {
    const supabase = await createSupabaseServerClient();
    const a = await analyse(
      supabase,
      orgId,
      id,
      org.businessType as Parameters<typeof analyse>[3],
      settings,
    );
    if (a === "missing") return new Response(null, { status: 404 });
    if (a === "expired") return new Response(null, { status: 410 });
    return new Response(errorsCsv(a.parsed.headers, a.parsed.rows, a.errors), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="import-problems.csv"',
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return new Response(null, { status: e instanceof ImportFileError ? 400 : 500 });
  }
}
