import "server-only";
import { PgBoss, type Queue, type WorkOptions } from "pg-boss";
import { z } from "zod";
import { reportError } from "@/lib/errors";

/**
 * pg-boss plumbing (Postgres job queue, schema `pgboss`, migration 0007).
 * - JOBS_DATABASE_URL is the Supabase SESSION pooler (port 5432), never the 6543 transaction
 *   pooler, which breaks pg-boss's LISTEN/NOTIFY and advisory locks.
 * - migrate/createSchema are off: the schema only changes through Supabase migrations.
 * - Handlers run with privileged database access (allowed only here and in src/lib/ops/db.ts).
 */

/** A job type. Handlers must be idempotent: a job can run again after a crash or a retry. */
export type JobHandler<S extends z.ZodType = z.ZodType> = {
  name: string;
  schema: S;
  /** Cron in Europe/Dublin time, for scheduled jobs. */
  cron?: string;
  handle: (data: z.infer<S>) => Promise<void>;
};

/**
 * Base payload for tenant jobs (imports, exports, reports). Handlers run with RLS bypassed, so:
 * take org_id from the verified session when enqueuing (never from the client), carry the acting
 * user_id too, and re-check that user's membership of org_id inside the handler.
 */
export const orgJobPayload = z.object({ org_id: z.uuid(), user_id: z.uuid() });

export const DEFAULT_QUEUE_OPTIONS: Omit<Queue, "name"> = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true, // 30 s, 60 s, 120 s ...
  retryDelayMax: 600,
  expireInSeconds: 300,
};

export function createBoss(connectionString: string): PgBoss {
  return new PgBoss({
    connectionString,
    schema: "pgboss",
    max: 3, // plus 2 in src/lib/ops/db.ts: 5 connections per app instance
    application_name: "tillflow-jobs",
    migrate: false,
    createSchema: false,
  });
}

/** Creates the queue (idempotent) and starts a worker that validates each payload first. */
export async function registerHandler<S extends z.ZodType>(
  boss: PgBoss,
  handler: JobHandler<S>,
  queueOptions: Omit<Queue, "name"> = DEFAULT_QUEUE_OPTIONS,
  workOptions: WorkOptions = {},
): Promise<void> {
  await boss.createQueue(handler.name, queueOptions);
  await boss.work(handler.name, workOptions, async (jobs) => {
    for (const job of jobs) {
      try {
        await handler.handle(handler.schema.parse(job.data ?? {}));
      } catch (error) {
        await reportError(error, { source: "job", context: { job: handler.name } });
        throw error; // pg-boss records the failure and retries with backoff
      }
    }
  });
}
