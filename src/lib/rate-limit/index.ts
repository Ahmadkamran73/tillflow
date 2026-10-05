import "server-only";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { reportError } from "@/lib/errors";
import { checkRateLimit, type RateLimitResult } from "@/lib/ops/db";
import { createMemoryLimiter } from "./memory";

/**
 * Rate limits counted in Postgres (ops.check_rate_limit), shared by every app instance.
 * Keys are SHA-256 hashed here, so no IP or email ever reaches the table.
 *
 * If the database cannot be asked: AUTH limits fail CLOSED (refuse, "try again shortly"; sign-in
 * needs the database anyway), every other limit fails OPEN. Both cases are logged.
 *
 * Cashier PIN lockout (5 failures, 15 minutes) is NOT this limiter: it is a counter on the
 * cashier's row in the database.
 */
export const RATE_LIMITS = {
  login: { limit: 5, windowSec: 60, auth: true }, // per IP + email
  // Per email alone, so rotating a spoofed X-Forwarded-For cannot buy more password guesses.
  "login-account": { limit: 20, windowSec: 900, auth: true },
  "sign-up": { limit: 5, windowSec: 60, auth: true }, // per IP + email
  "magic-link": { limit: 5, windowSec: 60, auth: true }, // per IP + email
  "reset-account": { limit: 3, windowSec: 3600, auth: true }, // per email (or user)
  "reset-ip": { limit: 10, windowSec: 3600, auth: true }, // per IP
  mfa: { limit: 5, windowSec: 60, auth: true }, // per user
  export: { limit: 5, windowSec: 3600, auth: false }, // per user
  import: { limit: 5, windowSec: 3600, auth: false }, // per org
  "receipt-email": { limit: 30, windowSec: 3600, auth: false }, // per user
  "receipt-email-org": { limit: 200, windowSec: 3600, auth: false }, // per org
} as const;

export type RateLimitName = keyof typeof RATE_LIMITS;
export type AuthRateLimitName = {
  [K in RateLimitName]: (typeof RATE_LIMITS)[K]["auth"] extends true ? K : never;
}[RateLimitName];

export const RATE_LIMIT_UNAVAILABLE_MESSAGE =
  "We can't process this right now. Please try again shortly.";

export function rateLimitedMessage(retryAfterSeconds: number): string {
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return minutes <= 1
    ? "Too many attempts. Wait a minute and try again."
    : `Too many attempts. Try again in ${minutes} minutes.`;
}

export function hashKey(...parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/**
 * The visitor's IP behind Hostinger's proxy: X-Real-IP, else the LAST X-Forwarded-For entry
 * (Hostinger appends the real IP; earlier entries are whatever the client sent, so spoofable).
 */
export function ipFromHeaders(h: Headers): string {
  return (
    h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",").at(-1)?.trim() || "unknown"
  );
}

export async function clientIp(): Promise<string> {
  return ipFromHeaders(await headers());
}

export type RateLimitOutcome = RateLimitResult & { unavailable?: true };

/** Counts one attempt for `name` keyed by `keyParts` (hashed). */
export async function rateLimit(
  name: RateLimitName,
  ...keyParts: string[]
): Promise<RateLimitOutcome> {
  const policy = RATE_LIMITS[name];
  try {
    // A hung database must not hang sign-in: give up after 3 s (auth then fails closed).
    return await Promise.race([
      checkRateLimit(name, hashKey(...keyParts), policy.limit, policy.windowSec),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("rate limit timeout")), 3_000),
      ),
    ]);
  } catch (error) {
    await reportError(error, { source: "server", context: { bucket: name } });
    return policy.auth
      ? { allowed: false, remaining: 0, retryAfterSeconds: 0, unavailable: true }
      : { allowed: true, remaining: 0, retryAfterSeconds: 0, unavailable: true };
  }
}

/** For auth forms: null when the attempt may go ahead, otherwise the message to show. */
export async function authRateLimitError(
  name: AuthRateLimitName,
  ...keyParts: string[]
): Promise<string | null> {
  const outcome = await rateLimit(name, ...keyParts);
  if (outcome.allowed) return null;
  return outcome.unavailable
    ? RATE_LIMIT_UNAVAILABLE_MESSAGE
    : rateLimitedMessage(outcome.retryAfterSeconds);
}

/**
 * Per-PROCESS limiter for high-volume, low-risk endpoints (/api/v1/sync/*, /api/log-error), where
 * a database write per request isn't worth it. Each app instance counts on its own, so keep the
 * limits generous. Cannot fail, so it is effectively fail-open.
 */
const memoryLimiters = new Map<string, ReturnType<typeof createMemoryLimiter>>();

export function memoryRateLimit(
  name: string,
  key: string,
  limit: number,
  windowMs: number,
): boolean {
  let limiter = memoryLimiters.get(name);
  if (!limiter) {
    limiter = createMemoryLimiter(limit, windowMs);
    memoryLimiters.set(name, limiter);
  }
  return limiter.take(hashKey(key));
}
