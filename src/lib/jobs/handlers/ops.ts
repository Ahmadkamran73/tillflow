import "server-only";
import { z } from "zod";
import { sendAlertEmail } from "@/lib/errors/alert";
import { logger } from "@/lib/logger";
import {
  claimJobRun,
  cleanupRateLimits,
  errorDigest,
  pruneErrorEvents,
  pruneJobRuns,
  touchHeartbeat,
} from "@/lib/ops/db";
import type { JobHandler } from "../boss";

/**
 * Scheduled job bodies. Every job runs HOURLY and uses a last-run guard in the database
 * (ops.claim_job_run) for its daily work. pg-boss does not backfill cron ticks missed while the
 * app was stopped or asleep, so an hourly check catches up on the next hour instead of skipping
 * a whole day.
 */

const DIGEST_HOUR = 8; // 08:00 Europe/Dublin
const ERROR_RETENTION_DAYS = 90;

/** Date (YYYY-MM-DD) and hour in Ireland, whatever the server's time zone. */
export function dublinClock(now = new Date()): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Dublin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

export async function heartbeat(): Promise<void> {
  await touchHeartbeat();
}

export async function rateLimitCleanup(): Promise<void> {
  const removed = await cleanupRateLimits();
  logger.info({ job: "rate-limit-cleanup", removed }, "rate limit rows removed");
}

export async function errorPrune(now = new Date()): Promise<void> {
  const { date } = dublinClock(now);
  if (!(await claimJobRun("error-prune", date))) return;
  const removed = await pruneErrorEvents(ERROR_RETENTION_DAYS);
  const runsRemoved = await pruneJobRuns(30);
  logger.info({ job: "error-prune", removed, runsRemoved }, "old error events pruned");
}

export async function errorDigestJob(now = new Date()): Promise<void> {
  const { date, hour } = dublinClock(now);
  if (hour < DIGEST_HOUR) return;
  if (!(await claimJobRun("error-digest", date))) return;

  const rows = await errorDigest(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  if (rows.length === 0) {
    logger.info({ job: "error-digest" }, "no open errors in the last 24 hours");
    return;
  }
  const env = process.env.NEXT_PUBLIC_APP_ENV ?? "development";
  const lines = rows.map(
    (r) =>
      `- ${r.occurrences}x [${r.source}] ${r.route ?? "-"}  ${r.message}\n  first ${r.first_seen_at.toISOString()}, last ${r.last_seen_at.toISOString()}, ${r.fingerprint.slice(0, 12)}`,
  );
  await sendAlertEmail(
    `[Tillflow ${env}] Daily error digest: ${rows.length} open error${rows.length === 1 ? "" : "s"}`,
    [
      `Open (status "new") errors seen in the last 24 hours on ${env}, busiest first:`,
      "",
      ...lines,
      "",
      "Mark an error resolved or ignored in the error_events table to drop it from this digest.",
    ].join("\n"),
  );
}

const noPayload = z.object({});

/** Platform jobs, all scheduled. Each one is idempotent (guards, deletes, upserts). */
export const OPS_HANDLERS: JobHandler[] = [
  { name: "ops-heartbeat", schema: noPayload, cron: "* * * * *", handle: () => heartbeat() },
  {
    name: "ops-rate-limit-cleanup",
    schema: noPayload,
    cron: "7 * * * *",
    handle: () => rateLimitCleanup(),
  },
  { name: "ops-error-prune", schema: noPayload, cron: "17 * * * *", handle: () => errorPrune() },
  {
    name: "ops-error-digest",
    schema: noPayload,
    cron: "27 * * * *",
    handle: () => errorDigestJob(),
  },
];
