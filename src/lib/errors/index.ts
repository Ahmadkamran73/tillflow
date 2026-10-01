import "server-only";
import { logger } from "@/lib/logger";
import { recordError } from "@/lib/ops/db";
import { sendAlertEmail } from "./alert";
import { fingerprint, scrubContext, scrubRoute, scrubText } from "./scrub";

export type ErrorSource = "server" | "browser" | "job";

export type ErrorReport = {
  source: ErrorSource;
  route?: string | null;
  context?: Record<string, unknown>;
};

const DB_TIMEOUT_MS = 3_000;

function describe(error: unknown): { name: string; message: string; stack: string | null } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null };
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof e.name === "string" ? e.name : "Error",
      message: String(e.message),
      stack: typeof e.stack === "string" ? e.stack : null,
    };
  }
  return { name: "NonError", message: String(error), stack: null };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
}

/**
 * Logs an error (scrubbed), stores it in error_events grouped by fingerprint, and emails an
 * alert for a new fingerprint. Never throws and never rejects: error reporting must not become
 * a second error.
 */
export async function reportError(error: unknown, report: ErrorReport): Promise<void> {
  try {
    const raw = describe(error);
    const message = scrubText(`${raw.name}: ${raw.message}`, 1000);
    const stack = raw.stack ? scrubText(raw.stack, 8000) : null;
    const route = scrubRoute(report.route);
    const environment = process.env.NEXT_PUBLIC_APP_ENV ?? "development";
    const context = scrubContext({
      ...report.context,
      environment,
      commit: process.env.APP_COMMIT?.slice(0, 12),
    });
    const fp = fingerprint(report.source, raw.name, raw.message, raw.stack);

    logger.error({ source: report.source, route, fingerprint: fp, ...context }, message);

    const result = await withTimeout(
      recordError({
        fingerprint: fp,
        source: report.source,
        message,
        stack,
        route,
        environment,
        context,
      }),
      DB_TIMEOUT_MS,
    );

    if (result.shouldAlert) {
      await sendAlertEmail(
        `[Tillflow ${environment}] New error: ${message.slice(0, 120)}`,
        [
          `A new error was recorded on ${environment}.`,
          "",
          `Message:  ${message}`,
          `Source:   ${report.source}`,
          `Route:    ${route ?? "-"}`,
          `Fingerprint: ${fp}`,
          "",
          stack ? `Stack (scrubbed):\n${stack.slice(0, 2000)}` : "No stack trace.",
          "",
          "Look it up in the error_events table by fingerprint. No further emails are sent for this",
          "error unless it is marked resolved and happens again.",
        ].join("\n"),
      );
    }
  } catch {
    try {
      logger.error({ source: report.source }, "error reporting failed");
    } catch {
      // Nothing left to do: never throw from the error reporter.
    }
  }
}
