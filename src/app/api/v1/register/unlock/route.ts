import type { NextRequest } from "next/server";
import { z } from "zod";
import { verifyPin } from "@/lib/auth/pin";
import { authenticateDevice } from "@/lib/device/auth";
import { reportError } from "@/lib/errors";
import { issueApproval, pinAttemptBegin, pinAttemptFinish } from "@/lib/device/service";
import { RATE_LIMIT_UNAVAILABLE_MESSAGE, rateLimit, rateLimitedMessage } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const body = z.strictObject({
  userId: z.uuid(),
  pin: z.string().regex(/^\d{4,6}$/),
  /** unlock: a cashier starts serving. override: a manager approves one action. */
  purpose: z.enum(["unlock", "override"]),
  /** What an override is for; the approval the server issues is good for this and nothing else. */
  approvalFor: z.enum(["discount", "no_sale", "refund"]).optional(),
  /** A refund approval names the sale it is for and the most it may be spent on (cents). */
  saleId: z.uuid().optional(),
  maxCents: z.int().min(0).max(100_000_000).optional(),
});
const NO_STORE = { "Cache-Control": "no-store" };

/**
 * POST /api/v1/register/unlock: checks one person's PIN on a paired till. Works only with a valid
 * device token (a PIN means nothing on an unpaired device). Every check first reserves an attempt
 * in the database, so the 5-failures / 15-minute lockout holds even against parallel guesses; a
 * wrong PIN, an unknown person and someone with no PIN all answer "invalid".
 */
export async function POST(request: NextRequest) {
  const device = await authenticateDevice();
  if (!device.ok) return Response.json({ error: "not paired" }, { status: 401, headers: NO_STORE });

  const limited = await rateLimit("pin-device", device.registerId);
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
  if (!parsed.success)
    return Response.json({ error: "bad request" }, { status: 400, headers: NO_STORE });
  const { userId, pin, purpose, approvalFor, saleId, maxCents } = parsed.data;
  const bound = saleId !== undefined && maxCents !== undefined;
  if (
    (purpose === "override" && !approvalFor) ||
    (approvalFor === "refund") !== bound ||
    (approvalFor !== "refund" && (saleId !== undefined || maxCents !== undefined))
  ) {
    return Response.json({ error: "bad request" }, { status: 400, headers: NO_STORE });
  }

  try {
    const attempt = await pinAttemptBegin(device.tokenHash, userId);
    if (attempt.status === "locked") {
      return Response.json(
        { result: "locked", lockedUntil: attempt.lockedUntil.toISOString() },
        { headers: NO_STORE },
      );
    }
    if (attempt.status === "no_pin") {
      return Response.json({ result: "invalid" }, { headers: NO_STORE });
    }

    const ok = await verifyPin(pin, attempt.pinHash);
    const outcome = await pinAttemptFinish(device.tokenHash, userId, ok);
    if (!ok) {
      return outcome.locked && outcome.lockedUntil
        ? Response.json(
            { result: "locked", lockedUntil: outcome.lockedUntil.toISOString() },
            { headers: NO_STORE },
          )
        : Response.json({ result: "invalid" }, { headers: NO_STORE });
    }
    // The PIN is right. An override must come from a manager or owner.
    if (purpose === "override" && attempt.role === "cashier") {
      return Response.json({ result: "not_allowed" }, { headers: NO_STORE });
    }
    if (purpose === "override" && approvalFor) {
      // The server saw this manager's PIN: give the till a single-use proof to attach to ONE sale or
      // event. Without it (offline approvals) the server treats the approval as an unverified claim.
      const approvalId = await issueApproval(
        device.tokenHash,
        userId,
        approvalFor,
        bound ? { saleId, maxCents } : undefined,
      );
      return Response.json(
        { result: "ok", userId, role: attempt.role, approvalId },
        { headers: NO_STORE },
      );
    }
    return Response.json({ result: "ok", userId, role: attempt.role }, { headers: NO_STORE });
  } catch (e) {
    await reportError(e, { source: "server", route: "/api/v1/register/unlock" });
    return Response.json({ error: "try again" }, { status: 503, headers: NO_STORE });
  }
}
