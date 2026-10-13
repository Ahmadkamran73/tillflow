import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { ImportFileError } from "@/lib/import/parse";
import { analyse, fileErrorMessage, jobType, settingsProblem, settingsSchema } from "@/lib/import/server";
import { getOrganisation } from "@/lib/org";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const body = settingsSchema.extend({ orgId: z.uuid() });

/** POST /api/v1/imports/<id>/preview: checks every row with the chosen mapping. Writes nothing. */
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
  const supabase = await createSupabaseServerClient();
  const type = await jobType(supabase, orgId, id);
  if (!type) return new Response(null, { status: 404 });
  const problem = settingsProblem(type, settings);
  if (problem) return json({ error: t(problem) }, 400);
  // Every preview re-reads the stored file (an Excel file starts a parser process): count it per shop.
  if (!(await rateLimit("import-reparse", orgId)).allowed) {
    return json({ error: t("import.err.limit") }, 429);
  }
  try {
    const a = await analyse(
      supabase,
      orgId,
      id,
      org.businessType as Parameters<typeof analyse>[3],
      settings,
    );
    if (a === "missing") return new Response(null, { status: 404 });
    if (a === "expired") return json({ error: t("import.err.expired") }, 410);
    return json({
      totalRows: a.parsed.rows.length,
      readyRows: a.readyRows,
      errorRows: new Set(a.errors.map((e) => e.row)).size,
      willCreate: a.willCreate,
      willUpdate: a.willUpdate,
      willSkip: a.willSkip,
      vatDefaulted: a.vatDefaulted,
      errors: a.errors.slice(0, 100),
    });
  } catch (e) {
    if (e instanceof ImportFileError) return json({ error: fileErrorMessage(e) }, 400);
    await reportError(e, { source: "server", route: "imports-preview" });
    return json({ error: t("import.err.generic") }, 500);
  }
}
