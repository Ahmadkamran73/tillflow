import type { NextRequest } from "next/server";
import { z } from "zod";
import { setDeviceToken } from "@/lib/device/cookie";
import {
  generateDeviceToken,
  hashDeviceToken,
  hashPairingCode,
  normalisePairingCode,
} from "@/lib/device/token";
import { appUrl } from "@/lib/auth/config";
import { reportError } from "@/lib/errors";
import { pairRegister } from "@/lib/device/service";
import {
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
  ipFromHeaders,
  rateLimit,
  rateLimitedMessage,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const body = z.strictObject({ code: z.string().min(1).max(32) });
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Only this app's own pages may pair a browser. Without this, another site could submit a form that
 * pairs a visitor's browser with a code the attacker chose (login CSRF). Behind Hostinger's proxy
 * nextUrl carries the internal host, so the app's own URL is accepted too.
 */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const host = new URL(origin).host;
    return host === new URL(appUrl()).host || host === request.nextUrl.host;
  } catch {
    return false;
  }
}

/**
 * POST /api/v1/register/pair {code}: a till swaps the one-time code a manager made for a device
 * token, which goes into an httpOnly cookie (only its hash is stored). Public on purpose (the
 * till has nothing yet), so it is rate limited per IP and fails closed. A wrong, used or expired
 * code all look the same.
 */
export async function POST(request: NextRequest) {
  if (!sameOrigin(request) || !request.headers.get("content-type")?.startsWith("application/json")) {
    return Response.json({ error: "not allowed" }, { status: 403, headers: NO_STORE });
  }
  const limited = await rateLimit("pair", ipFromHeaders(request.headers));
  if (!limited.allowed) {
    return Response.json(
      {
        error: limited.unavailable
          ? RATE_LIMIT_UNAVAILABLE_MESSAGE
          : rateLimitedMessage(limited.retryAfterSeconds),
      },
      {
        status: 429,
        headers: { ...NO_STORE, "Retry-After": String(limited.retryAfterSeconds || 30) },
      },
    );
  }

  const length = Number(request.headers.get("content-length"));
  if (!Number.isFinite(length) || length <= 0 || length > 1024) {
    return Response.json({ error: "bad size" }, { status: 413, headers: NO_STORE });
  }
  let json: unknown;
  try {
    json = JSON.parse(await request.text());
  } catch {
    return Response.json({ error: "bad json" }, { status: 400, headers: NO_STORE });
  }
  const parsed = body.safeParse(json);
  const code = parsed.success ? normalisePairingCode(parsed.data.code) : null;
  if (!code) {
    return Response.json(
      { error: "That code is not valid or has expired." },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const token = generateDeviceToken();
    const paired = await pairRegister(hashPairingCode(code), hashDeviceToken(token));
    if (!paired) {
      return Response.json(
        { error: "That code is not valid or has expired." },
        { status: 400, headers: NO_STORE },
      );
    }
    await setDeviceToken(token);
    return Response.json({ orgId: paired.orgId }, { headers: NO_STORE });
  } catch (e) {
    await reportError(e, { source: "server", route: "/api/v1/register/pair" });
    return Response.json({ error: "try again" }, { status: 503, headers: NO_STORE });
  }
}
