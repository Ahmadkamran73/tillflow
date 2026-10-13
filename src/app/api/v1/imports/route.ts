import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { reportError } from "@/lib/errors";
import { t } from "@/lib/i18n";
import { importFieldsFor } from "@/lib/import/fields";
import { ImportFileError, MAX_FILE_BYTES, parseUpload } from "@/lib/import/parse";
import { autoMatch, detectSource } from "@/lib/import/presets";
import { fileErrorMessage, importTypeSchema } from "@/lib/import/server";
import { getOrganisation } from "@/lib/org";
import { rateLimit } from "@/lib/rate-limit";
import { putImportFile } from "@/lib/storage";

export const dynamic = "force-dynamic";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * POST /api/v1/imports?orgId=<uuid>  (multipart, field "file")
 * Parses the upload on the server (CSV, xlsx or JSON only; .sql is refused), stores it for 7 days
 * and answers with the columns, a few sample rows and a suggested mapping.
 * Owner or manager only; 5 imports per hour per shop.
 */
export async function POST(request: NextRequest) {
  const orgId = z.uuid().safeParse(request.nextUrl.searchParams.get("orgId"));
  if (!orgId.success) return new Response(null, { status: 404 });
  const auth = await authorizeApi(["owner", "manager"], orgId.data);
  if (!auth.ok) return new Response(null, { status: auth.status });
  // What the file holds: products (default), stock levels or customers.
  const kind = importTypeSchema.safeParse(request.nextUrl.searchParams.get("type") ?? "products");
  if (!kind.success) return new Response(null, { status: 400 });

  const length = Number(request.headers.get("content-length") ?? "0");
  if (!length || length > MAX_FILE_BYTES + 100_000) {
    return json({ error: t("import.err.size") }, 413);
  }
  const limit = await rateLimit("import", orgId.data);
  if (!limit.allowed) return json({ error: t("import.err.limit") }, 429);

  let file: File | null = null;
  try {
    const f = (await request.formData()).get("file");
    file = f instanceof File ? f : null;
  } catch {
    return json({ error: t("import.err.unreadable") }, 400);
  }
  if (!file) return json({ error: t("import.err.empty") }, 400);

  const bytes = Buffer.from(await file.arrayBuffer());
  try {
    const parsed = await parseUpload(file.name, bytes);
    const org = await getOrganisation(orgId.data);
    if (!org) return new Response(null, { status: 404 });

    const importId = randomUUID();
    const supabase = await createSupabaseServerClient();
    const { error } = await putImportFile(supabase, {
      orgId: orgId.data,
      importId,
      fileName: file.name.slice(0, 200),
      bytes,
      totalRows: parsed.rows.length,
      type: kind.data,
    });
    if (error) {
      if (error.code === "55006") return json({ error: t("import.err.busy") }, 409);
      if (error.code === "42501") return new Response(null, { status: 403 });
      await reportError(error, { source: "server", route: "imports-upload" });
      return json({ error: t("import.err.generic") }, 503);
    }
    // The Square/Lightspeed/Imonggo/Shopify presets describe product exports only.
    const source = kind.data === "products" ? detectSource(parsed.headers) : null;
    const fields = importFieldsFor(kind.data, org.businessType as Parameters<typeof importFieldsFor>[1]);
    return json({
      importType: kind.data,
      importId,
      fileName: file.name,
      headers: parsed.headers,
      sample: parsed.rows.slice(0, 3),
      totalRows: parsed.rows.length,
      source,
      mapping: autoMatch(parsed.headers, source, fields),
      fields,
    });
  } catch (e) {
    if (e instanceof ImportFileError)
      return json({ error: fileErrorMessage(e), code: e.code }, 400);
    await reportError(e, { source: "server", route: "imports-upload" });
    return json({ error: t("import.err.generic") }, 500);
  }
}
