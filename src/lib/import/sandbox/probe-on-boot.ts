import "server-only";
import { logger } from "@/lib/logger";
import { runProbe } from "./probe.mjs";

/**
 * Runs the sandbox probe once and writes the report to the application log, one JSON line. Started
 * from src/instrumentation.ts only when IMPORT_SANDBOX_PROBE_ON_BOOT=true. The probe starts a few
 * misbehaving child processes (a heap bomb, a runaway loop, a memory hog capped near 1 GB); it is a
 * one-off check on a new host, not something to leave switched on.
 */
export async function probeAndLog(): Promise<void> {
  try {
    const report = await runProbe({ root: process.cwd() });
    logger.info(
      {
        job: "import-sandbox-probe",
        verdict: report.verdict,
        requiredFailed: report.requiredFailed,
        report,
      },
      "xlsx sandbox probe",
    );
  } catch (error) {
    logger.error(
      { job: "import-sandbox-probe", code: (error as { code?: string }).code ?? "error" },
      "xlsx sandbox probe crashed",
    );
  }
}
