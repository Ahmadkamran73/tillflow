import "server-only";
import type { PgBoss } from "pg-boss";
import { reportError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createBoss, registerHandler, type JobHandler } from "./boss";
import { OPS_HANDLERS } from "./handlers/ops";

/**
 * Background jobs. Later steps add their handlers (import, reports, exports, billing) here.
 * The worker is started once per Node.js process from src/instrumentation.ts.
 */
const HANDLERS: JobHandler[] = [...OPS_HANDLERS];

const RETRY_MS = 60_000;

const globalForJobs = globalThis as unknown as {
  tillflowBoss?: Promise<PgBoss>;
  tillflowWorkers?: Promise<PgBoss | null>;
};

/** One started pg-boss per process (send-only until startJobs() adds workers). */
function getBoss(): Promise<PgBoss> {
  globalForJobs.tillflowBoss ??= (async () => {
    const url = process.env.JOBS_DATABASE_URL;
    if (!url) throw new Error("JOBS_DATABASE_URL is not set");
    const boss = createBoss(url);
    boss.on(
      "error",
      (error) => void reportError(error, { source: "job", context: { job: "pg-boss" } }),
    );
    await boss.start();
    return boss;
  })().catch((error) => {
    globalForJobs.tillflowBoss = undefined; // let the next call try again
    throw error;
  });
  return globalForJobs.tillflowBoss;
}

/** Queues a job after validating its payload with the handler's schema. Returns the job id. */
export async function enqueue(name: string, payload: unknown): Promise<string | null> {
  const handler = HANDLERS.find((h) => h.name === name);
  if (!handler) throw new Error(`Unknown job: ${name}`);
  const data = handler.schema.parse(payload) as object;
  return (await getBoss()).send(name, data);
}

/** Registers every handler and its schedule. Retries every minute if the database is down. */
export function startJobs(): Promise<PgBoss | null> {
  globalForJobs.tillflowWorkers ??= boot();
  return globalForJobs.tillflowWorkers;
}

async function boot(): Promise<PgBoss | null> {
  if (!process.env.JOBS_DATABASE_URL) {
    logger.warn({ job: "boot" }, "JOBS_DATABASE_URL is not set: background jobs are off");
    return null;
  }
  try {
    const boss = await getBoss();
    for (const handler of HANDLERS) {
      await registerHandler(boss, handler);
      if (handler.cron) {
        await boss.schedule(handler.name, handler.cron, null, {
          tz: "Europe/Dublin",
          missed: "once",
        });
      }
    }
    logger.info({ job: "boot" }, "background jobs started");
    return boss;
  } catch (error) {
    await reportError(error, { source: "job", context: { job: "boot" } });
    // Until this works /api/health reports "jobs":"down".
    setTimeout(() => {
      globalForJobs.tillflowWorkers = undefined;
      void startJobs();
    }, RETRY_MS).unref();
    return null;
  }
}
