import { NextResponse } from "next/server";
import { heartbeatAgeSeconds } from "@/lib/ops/db";

export const dynamic = "force-dynamic";

/** The worker beats every minute; after 5 minutes of silence jobs count as down. */
const HEARTBEAT_STALE_SECONDS = 5 * 60;

// The probe shares the small privileged pool with the auth rate limiter, so a flood of public
// health checks must not reach the database: one query per 10 s at most.
const CACHE_MS = 10_000;
let cached: { at: number; result: Promise<number | null> } | undefined;

function probe(): Promise<number | null> {
  const now = Date.now();
  if (!cached || now - cached.at >= CACHE_MS) {
    cached = {
      at: now,
      result: Promise.race([
        heartbeatAgeSeconds(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 4_000)),
      ]),
    };
    cached.result.catch(() => {}); // a rejection is handled by the caller; avoid unhandled noise
  }
  return cached.result;
}

/**
 * Uptime probe. Public on purpose: it reveals only version, commit, environment and up/down.
 * 200 while the database answers ("status":"ok"), even if jobs are down ("jobs":"down"), so one
 * Better Stack monitor watches the app and a second one watches the keyword "jobs":"ok".
 * 503 only when the database does not answer.
 */
export async function GET() {
  const base = {
    version: process.env.APP_VERSION ?? "unknown",
    commit: process.env.APP_COMMIT ?? "unknown",
    environment: process.env.NEXT_PUBLIC_APP_ENV ?? "unknown",
  };
  const headers = { "Cache-Control": "no-store" };
  try {
    const age = await probe();
    const jobs = age !== null && age <= HEARTBEAT_STALE_SECONDS ? "ok" : "down";
    return NextResponse.json({ status: "ok", database: "ok", jobs, ...base }, { headers });
  } catch {
    return NextResponse.json(
      { status: "down", database: "down", jobs: "down", ...base },
      { status: 503, headers },
    );
  }
}
