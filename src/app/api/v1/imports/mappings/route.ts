import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { mappingSchema } from "@/lib/import/server";

export const dynamic = "force-dynamic";

const orgParam = (request: NextRequest) =>
  z.uuid().safeParse(request.nextUrl.searchParams.get("orgId"));

/** GET /api/v1/imports/mappings?orgId=: this shop's saved column mappings. */
export async function GET(request: NextRequest) {
  const orgId = orgParam(request);
  if (!orgId.success) return new Response(null, { status: 404 });
  const auth = await authorizeApi(["owner", "manager"], orgId.data);
  if (!auth.ok) return new Response(null, { status: auth.status });
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("import_mappings")
    .select("id, name, mapping")
    .eq("org_id", orgId.data)
    .order("name");
  return Response.json(data ?? [], { headers: { "Cache-Control": "no-store" } });
}

const create = z.object({
  orgId: z.uuid(),
  name: z.string().trim().min(1).max(60),
  mapping: mappingSchema,
});

/** POST: saves a mapping under a name (a name already used answers 409). */
export async function POST(request: NextRequest) {
  const parsed = create.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json({ error: t("import.err.mappingName") }, { status: 400 });
  const auth = await authorizeApi(["owner", "manager"], parsed.data.orgId);
  if (!auth.ok) return new Response(null, { status: auth.status });
  const supabase = await createSupabaseServerClient();
  const id = randomUUID();
  const { error } = await supabase.from("import_mappings").insert({
    id,
    org_id: parsed.data.orgId,
    name: parsed.data.name,
    mapping: parsed.data.mapping,
  });
  if (error) {
    const dup = error.code === "23505";
    return Response.json(
      { error: dup ? t("import.err.mappingDup") : t("import.err.generic") },
      { status: dup ? 409 : 503 },
    );
  }
  return Response.json({ id }, { status: 201 });
}

/** DELETE /api/v1/imports/mappings?orgId=&id= */
export async function DELETE(request: NextRequest) {
  const orgId = orgParam(request);
  const id = z.uuid().safeParse(request.nextUrl.searchParams.get("id"));
  if (!orgId.success || !id.success) return new Response(null, { status: 404 });
  const auth = await authorizeApi(["owner", "manager"], orgId.data);
  if (!auth.ok) return new Response(null, { status: auth.status });
  const supabase = await createSupabaseServerClient();
  await supabase.from("import_mappings").delete().eq("org_id", orgId.data).eq("id", id.data);
  return new Response(null, { status: 204 });
}
