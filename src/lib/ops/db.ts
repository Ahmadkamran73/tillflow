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

// ---------------------------------------------------------------- device pairing and PINs (step 1.7)
// A paired till holds only a device token; the app passes its SHA-256 hash. Each function resolves
// the shop and the till from that hash itself and never trusts an org or register id from the till.

export type DeviceContext = { orgId: string; registerId: string; locationId: string };

/** Who is this token? null when unknown, revoked or the shop is closed. Also the till's heartbeat. */
export async function deviceAuth(tokenHash: string): Promise<DeviceContext | null> {
  const [row] = await db()<{ org_id: string; register_id: string; location_id: string }[]>`
    select * from ops.device_auth(${tokenHash})`;
  return row
    ? { orgId: row.org_id, registerId: row.register_id, locationId: row.location_id }
    : null;
}

/** Exchanges a pairing code (hashed) for the till it was issued for. null: unknown, used or expired. */
export async function pairRegister(
  codeHash: string,
  tokenHash: string,
): Promise<{ orgId: string; registerId: string } | null> {
  const [row] = await db()<{ org_id: string; register_id: string }[]>`
    select * from ops.pair_register(${codeHash}, ${tokenHash})`;
  return row ? { orgId: row.org_id, registerId: row.register_id } : null;
}

export async function deviceFeedMeta(tokenHash: string): Promise<unknown> {
  const [row] = await db()<{ m: unknown }[]>`select ops.device_feed_meta(${tokenHash}) as m`;
  return row?.m ?? null;
}

/** Timezone, VAT rates and the discount threshold of the till's shop, for re-pricing synced sales. */
export async function deviceSyncMeta(tokenHash: string): Promise<unknown> {
  const [row] = await db()<{ m: unknown }[]>`select ops.device_sync_meta(${tokenHash}) as m`;
  return row?.m ?? null;
}

/** The payment types of the till's location and the shop's business type (ops.device_tender_types). */
export async function deviceTenderTypes(tokenHash: string): Promise<unknown> {
  const [row] = await db()<{ m: unknown }[]>`select ops.device_tender_types(${tokenHash}) as m`;
  return row?.m ?? null;
}

export type FeedTable =
  | "categories"
  | "products"
  | "variants"
  | "modifier_groups"
  | "modifiers"
  | "product_modifier_groups";

export async function deviceFeedTable(
  tokenHash: string,
  table: FeedTable,
  since: Date | null,
  after: string | null,
  limit: number,
): Promise<unknown[] | null> {
  const [row] = await db()<{ t: unknown[] | null }[]>`
    select ops.device_feed_table(${tokenHash}, ${table}, ${since}, ${after}, ${limit}) as t`;
  return row?.t ?? null;
}

export async function deviceSaleCatalogAsOf(
  tokenHash: string,
  variantIds: string[],
  modifierIds: string[],
  at: Date,
): Promise<unknown> {
  const [row] = await db()<{ c: unknown }[]>`
    select ops.device_sale_catalog_as_of(${tokenHash}, ${variantIds}::uuid[], ${modifierIds}::uuid[], ${at}) as c`;
  return row?.c ?? null;
}

export async function deviceSalesKnown(tokenHash: string, ids: string[]): Promise<string[]> {
  const rows = await db()<{ id: string }[]>`
    select ops.device_sales_known(${tokenHash}, ${ids}::uuid[]) as id`;
  return rows.map((r) => r.id);
}

export type PinAttemptBegin =
  | { status: "ok"; pinHash: string; role: "owner" | "manager" | "cashier" }
  | { status: "locked"; lockedUntil: Date }
  | { status: "no_pin" };

/** Reserves one attempt BEFORE the PIN is checked (see migration 0022), so parallel guesses cannot beat the limit. */
export async function pinAttemptBegin(tokenHash: string, userId: string): Promise<PinAttemptBegin> {
  const [row] = await db()<
    {
      status: string;
      pin_hash: string | null;
      role: "owner" | "manager" | "cashier" | null;
      locked_until: Date | null;
    }[]
  >`select * from ops.pin_attempt_begin(${tokenHash}, ${userId})`;
  if (!row) throw new Error("pin_attempt_begin returned no row");
  if (row.status === "ok" && row.pin_hash && row.role) {
    return { status: "ok", pinHash: row.pin_hash, role: row.role };
  }
  if (row.status === "locked" && row.locked_until) {
    return { status: "locked", lockedUntil: row.locked_until };
  }
  return { status: "no_pin" };
}

export async function pinAttemptFinish(
  tokenHash: string,
  userId: string,
  ok: boolean,
): Promise<{ locked: boolean; lockedUntil: Date | null }> {
  const [row] = await db()<{ locked: boolean; locked_until: Date | null }[]>`
    select * from ops.pin_attempt_finish(${tokenHash}, ${userId}, ${ok})`;
  return { locked: row?.locked === true, lockedUntil: row?.locked_until ?? null };
}

export type ApprovalPurpose = "discount" | "no_sale" | "refund";

/**
 * Turns a manager PIN the server just verified into a single-use proof (register_approvals) for one
 * sale or event on this till. The sale/event carries only the returned id; the database derives the
 * approver from it.
 */
export async function issueApproval(
  tokenHash: string,
  userId: string,
  purpose: ApprovalPurpose,
): Promise<string> {
  const [row] = await db()<{ id: string }[]>`
    select ops.issue_approval(${tokenHash}, ${userId}, ${purpose}) as id`;
  if (!row) throw new Error("issue_approval returned no row");
  return row.id;
}

export async function recordRegisterEvents(tokenHash: string, events: unknown): Promise<string[]> {
  const rows = await db()<{ id: string }[]>`
    select ops.record_register_events(${tokenHash}, ${db().json(events as postgres.JSONValue)}) as id`;
  return rows.map((r) => r.id);
}
