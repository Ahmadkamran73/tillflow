import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { createMemoryLimiter } from "./memory";

/** 5 attempts per minute per identifier, per bucket. */
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60_000;

export type Bucket = "login" | "reset" | "magic-link" | "sign-up" | "mfa";

const upstashConfigured = Boolean(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
);

let redis: Redis | undefined;
const upstash = new Map<Bucket, Ratelimit>();
const memory = new Map<Bucket, ReturnType<typeof createMemoryLimiter>>();
let warned = false;

function upstashFor(bucket: Bucket) {
  redis ??= Redis.fromEnv();
  let limiter = upstash.get(bucket);
  if (!limiter) {
    limiter = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(MAX_ATTEMPTS, "60 s"),
      prefix: `tillflow:rl:${bucket}`,
    });
    upstash.set(bucket, limiter);
  }
  return limiter;
}

function memoryFor(bucket: Bucket) {
  if (!warned) {
    warned = true;
    console.warn(
      "[rate-limit] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set: using an in-memory limiter. " +
        "It only counts within one server instance, so set Upstash before deploying.",
    );
  }
  let limiter = memory.get(bucket);
  if (!limiter) {
    limiter = createMemoryLimiter(MAX_ATTEMPTS, WINDOW_MS);
    memory.set(bucket, limiter);
  }
  return limiter;
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

/**
 * Returns true when the attempt is allowed. Identifiers are hashed before they reach Redis or
 * memory, so emails and IPs are never stored. If Upstash itself errors we allow the attempt
 * (an outage must not lock every shop out) and log only the bucket name.
 */
export async function allowAttempt(bucket: Bucket, ...parts: string[]): Promise<boolean> {
  const id = createHash("sha256").update(parts.join("|")).digest("hex");
  if (!upstashConfigured) return memoryFor(bucket).take(id);
  try {
    const { success } = await upstashFor(bucket).limit(id);
    return success;
  } catch {
    console.error(`[rate-limit] Upstash unavailable for bucket ${bucket}; allowing the attempt`);
    return true;
  }
}

export const RATE_LIMITED_MESSAGE = "Too many attempts. Wait a minute and try again.";
