import type { NextRequest } from "next/server";
import { z } from "zod";
import { authorizeApi, createSupabaseServerClient } from "@/lib/auth";
import { csvRow } from "@/lib/csv";
import { reportError } from "@/lib/errors";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const exportResult = z.object({
  customer: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    vat_number: z.string().nullable(),
    address: z.string().nullable(),
    notes: z.string().nullable(),
    marketing_consent_at: z.string().nullable(),
    created_at: z.string(),
    anonymised_at: z.string().nullable(),
  }),
  sales: z.array(
    z.object({
      sale_id: z.string(),
      receipt_seq: z.number(),
      completed_at: z.string(),
      total_cents: z.number(),
    }),
  ),
});

/**
 * GET /o/<orgId>/customers/<id>/export?format=json|csv: everything held about one customer
 * (GDPR access/portability). Owner or manager only, 5 per hour per user, audit-logged by
 * public.export_customer. CSV cells that start with = + - @ are escaped.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ orgId: string; customerId: string }> },
) {
  const { orgId, customerId } = await params;
  const format = request.nextUrl.searchParams.get("format") === "csv" ? "csv" : "json";
  const auth = await authorizeApi(["owner", "manager"], orgId);
  if (!auth.ok) return new Response(null, { status: auth.status });
  if (!z.uuid().safeParse(customerId).success) return new Response(null, { status: 404 });

  const limit = await rateLimit("export", auth.user.id);
  if (!limit.allowed) {
    return Response.redirect(
      new URL(`/o/${orgId}/customers/${customerId}?limit=1`, request.url),
      303,
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("export_customer", { p_org: orgId, p_id: customerId });
  if (error) {
    if (error.code !== "22023")
      await reportError(error, { source: "server", route: "customer-export" });
    return new Response(null, { status: error.code === "22023" ? 404 : 503 });
  }
  const out = exportResult.parse(data);
  const headers = {
    "Cache-Control": "no-store",
    "Content-Disposition": `attachment; filename="customer-${customerId}.${format}"`,
  };

  if (format === "json") {
    return new Response(JSON.stringify(out, null, 2), {
      headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    });
  }
  const c = out.customer;
  const lines = [
    csvRow(["section", "field", "value"]),
    ...(
      [
        ["id", c.id],
        ["name", c.name],
        ["email", c.email],
        ["phone", c.phone],
        ["vat_number", c.vat_number],
        ["address", c.address],
        ["notes", c.notes],
        ["marketing_consent_at", c.marketing_consent_at],
        ["created_at", c.created_at],
        ["anonymised_at", c.anonymised_at],
      ] as const
    ).map(([k, v]) => csvRow(["customer", k, v])),
    csvRow([]),
    csvRow(["sale_id", "receipt_seq", "completed_at", "total_cents"]),
    ...out.sales.map((s) => csvRow([s.sale_id, s.receipt_seq, s.completed_at, s.total_cents])),
  ];
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: { ...headers, "Content-Type": "text/csv; charset=utf-8" },
  });
}
