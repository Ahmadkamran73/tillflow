import type { NextRequest } from "next/server";
import { z } from "zod";
import { customerSearch, tillCustomerInput, toDbCustomer } from "@/lib/customer-schema";
import { authenticateDevice } from "@/lib/device/auth";
import { deviceCustomerCreate, deviceCustomerSearch } from "@/lib/device/service";
import { reportError } from "@/lib/errors";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";

export const dynamic = "force-dynamic";

const limiter = createMemoryLimiter(30, 60_000);
const noStore = { "Cache-Control": "no-store" };

const customer = z.object({
  id: z.uuid(),
  name: z.string(),
  hint: z.string().nullable().optional(),
});
const found = z.array(customer);

/** GET /api/v1/register/customers?orgId=&q=: customers of this shop for the till (paired device only, 8 rows). */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const orgId = z.uuid().safeParse(params.get("orgId"));
  const q = customerSearch.safeParse(params.get("q") ?? "");
  if (!orgId.success || !q.success) return Response.json({ error: "bad query" }, { status: 400 });
  const auth = await authenticateDevice(orgId.data);
  if (!auth.ok) return Response.json({ error: "not allowed" }, { status: auth.status });
  if (!limiter.take(auth.registerId)) {
    return Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": "30" } });
  }
  try {
    const rows = await deviceCustomerSearch(auth.tokenHash, q.data);
    if (rows === null) return Response.json({ error: "not allowed" }, { status: 401 });
    return Response.json({ customers: found.parse(rows) }, { headers: noStore });
  } catch (e) {
    await reportError(e, { source: "server", route: "/api/v1/register/customers" });
    return Response.json({ error: "try again" }, { status: 503 });
  }
}

/** POST /api/v1/register/customers?orgId=: adds a customer (409 when the email is taken). */
export async function POST(request: NextRequest) {
  const orgId = z.uuid().safeParse(request.nextUrl.searchParams.get("orgId"));
  if (!orgId.success) return Response.json({ error: "bad query" }, { status: 400 });
  const auth = await authenticateDevice(orgId.data);
  if (!auth.ok) return Response.json({ error: "not allowed" }, { status: auth.status });
  if (!limiter.take(auth.registerId)) {
    return Response.json({ error: "slow down" }, { status: 429, headers: { "Retry-After": "30" } });
  }
  // The body is small; refuse anything big before parsing it.
  if (Number(request.headers.get("content-length") ?? "0") > 4096) {
    return Response.json({ error: "too big" }, { status: 413 });
  }
  const body = tillCustomerInput.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    // Name the fields that failed so the till can mark them (never echo the values back).
    const fields = [...new Set(body.error.issues.map((i) => String(i.path[0])))];
    return Response.json({ error: "invalid", fields }, { status: 400 });
  }
  try {
    const created = await deviceCustomerCreate(auth.tokenHash, {
      id: body.data.id,
      consent: body.data.consent,
      ...toDbCustomer({ ...body.data, address: null, notes: null }),
    });
    if (created === null) return Response.json({ error: "not allowed" }, { status: 401 });
    return Response.json({ customer: customer.parse(created) }, { headers: noStore });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") return Response.json({ error: "email_taken" }, { status: 409 });
    if (code === "22023") return Response.json({ error: "invalid" }, { status: 400 });
    await reportError(e, { source: "server", route: "/api/v1/register/customers" });
    return Response.json({ error: "try again" }, { status: 503 });
  }
}
