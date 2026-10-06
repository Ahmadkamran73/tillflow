import "server-only";
import postgres from "postgres";

/**
 * The ONLY privileged database access in the app (besides pg-boss itself in src/lib/jobs).
 * It connects with JOBS_DATABASE_URL, which bypasses RLS, so it may only call the
 * SECURITY DEFINER functions in schema `ops` (migration 0006). Never add a query that touches a
 * table directly. `scripts/check-privileged-imports.ts` (CI) limits which files may import this.
 */

let client: postgres.Sql | undefined;

function db(): postgres.Sql {
  if (client) return client;
  const url = process.env.JOBS_DATABASE_URL;
  if (!url) throw new Error("JOBS_DATABASE_URL is not set");
  client = postgres(url, {
    max: 2, // with pg-boss's 3 this keeps each instance at 5 connections
    idle_timeout: 30,
    connect_timeout: 5,
    prepare: false,
    onnotice: () => {},
    connection: { application_name: "tillflow-ops" },
  });
  return client;
}

export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export async function checkRateLimit(
  bucket: string,
  keyHash: string,
  max: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const [row] = await db()<{ allowed: boolean; remaining: number; retry_after_seconds: number }[]>`
    select * from ops.check_rate_limit(${bucket}, ${keyHash}, ${max}, ${windowSeconds})`;
  if (!row) throw new Error("check_rate_limit returned no row");
  return {
    allowed: row.allowed,
    remaining: row.remaining,
    retryAfterSeconds: row.retry_after_seconds,
  };
}

export type ErrorRecord = {
  fingerprint: string;
  source: "server" | "browser" | "job";
  message: string;
  stack: string | null;
  route: string | null;
  environment: string;
  context: Record<string, string>;
};

export async function recordError(e: ErrorRecord) {
  const [row] = await db()<{ is_new: boolean; should_alert: boolean; occurrences: number }[]>`
    select * from ops.record_error(${e.fingerprint}, ${e.source}, ${e.message}, ${e.stack},
                                   ${e.route}, ${e.environment}, ${db().json(e.context)})`;
  return {
    isNew: row?.is_new === true,
    shouldAlert: row?.should_alert === true,
    occurrences: row?.occurrences ?? 0,
  };
}

export type DigestRow = {
  fingerprint: string;
  source: string;
  message: string;
  route: string | null;
  occurrences: number;
  status: string;
  first_seen_at: Date;
  last_seen_at: Date;
};

export async function errorDigest(since: Date): Promise<DigestRow[]> {
  return db()<DigestRow[]>`select * from ops.error_digest(${since})`;
}

export async function pruneErrorEvents(days = 90): Promise<number> {
  const [row] = await db()<{ n: number }[]>`select ops.prune_error_events(${days}) as n`;
  return row?.n ?? 0;
}

export async function cleanupRateLimits(): Promise<number> {
  const [row] = await db()<{ n: number }[]>`select ops.cleanup_rate_limits() as n`;
  return row?.n ?? 0;
}

/** True exactly once per (job, period) across all instances. */
export async function claimJobRun(job: string, period: string): Promise<boolean> {
  const [row] = await db()<{ claimed: boolean }[]>`
    select ops.claim_job_run(${job}, ${period}) as claimed`;
  return row?.claimed === true;
}

export async function pruneJobRuns(days = 30): Promise<number> {
  const [row] = await db()<{ n: number }[]>`select ops.prune_job_runs(${days}) as n`;
  return row?.n ?? 0;
}

export async function touchHeartbeat(): Promise<void> {
  await db()`select ops.touch_heartbeat()`;
}

/** Seconds since the job worker last beat (null if never). Throws if the database is down. */
export async function heartbeatAgeSeconds(): Promise<number | null> {
  const [row] = await db()<{ age: number | null }[]>`select ops.heartbeat_age_seconds() as age`;
  return row?.age ?? null;
}

// ---------------------------------------------------------------- sale sync (step 1.6)
// The sync route has authenticated the user and re-priced the sale; these functions re-check
// membership and register ownership themselves and write in one transaction.

export type RecordSaleResult = "created" | "duplicate" | "receipt_clash";

export async function recordSale(payload: unknown): Promise<RecordSaleResult> {
  const [row] = await db()<{ r: RecordSaleResult }[]>`
    select ops.record_sale(${db().json(payload as postgres.JSONValue)}) as r`;
  if (!row) throw new Error("record_sale returned no row");
  return row.r;
}

export async function recordSyncRejection(payload: unknown): Promise<void> {
  await db()`select ops.record_sync_rejection(${db().json(payload as postgres.JSONValue)})`;
}

export async function touchRegister(orgId: string, registerId: string, userId: string) {
  await db()`select ops.touch_register(${orgId}, ${registerId}, ${userId})`;
}
