import fs from "node:fs";
import path from "node:path";
import { ImportFileError } from "../errors";
import { SANDBOX_DEFAULTS } from "../limits.mjs";
import { readAnswer } from "./protocol";
import { createLimiter, isAlive, runSandboxed } from "./runner.mjs";
import { tinyWorkbook, TINY_ROWS } from "./xlsx-fixtures.mjs";

/**
 * The isolated Excel parser, as the application sees it.
 *
 * XLSX is OFF by default. It runs only when IMPORT_XLSX_ENABLED=true AND this host has passed the
 * self-test below. If either is missing the answer is a refusal: there is no in-process fallback,
 * because the point is that ExcelJS never parses an upload inside the web server process. (The
 * template download still uses ExcelJS to WRITE a fixed file; that is not parsing.)
 *
 * The parser child gets no credentials, no database, no writable files and no child processes (Node's
 * permission model), an empty environment, its own heap cap, and the parent kills it on a timeout,
 * on too much resident memory (polled; it can overshoot between polls) or on too much output. See
 * runner.mjs and docs/specs/bulk-import.md.
 *
 * Not restricted: network access, which Node cannot switch off. The child has no credentials or
 * database, but it can still reach the network (localhost included) and it holds the uploaded file.
 * A defect in ExcelJS that gave an attacker code execution would therefore not be contained against
 * the network; keep Node on a current security release.
 *
 * The self-test checks: the files exist; reads outside the allow-list, writes, child processes and
 * workers are denied; the child sees no secret-looking environment variable; a runaway child is
 * killed by the time limit; the real parser reads a built-in workbook under all of that; and, on
 * Linux, that the child's resident memory can be read (otherwise that ceiling would silently do
 * nothing). The heap cap, output cap and the `ulimit` limits are exercised by the manual probe only.
 */

export type XlsxState = "disabled" | "ready" | "unavailable";

const intEnv = (name: string, fallback: number, min = 1) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min ? n : fallback;
};

/** The limits in force, from IMPORT_SANDBOX_* or the defaults in limits.mjs. */
export function sandboxConfig() {
  const D = SANDBOX_DEFAULTS;
  return {
    timeoutMs: intEnv("IMPORT_SANDBOX_TIMEOUT_MS", D.timeoutMs),
    heapMb: intEnv("IMPORT_SANDBOX_HEAP_MB", D.heapMb),
    rssMb: intEnv("IMPORT_SANDBOX_RSS_MB", D.rssMb),
    outputBytes: intEnv("IMPORT_SANDBOX_OUTPUT_BYTES", D.outputBytes),
    stderrBytes: D.stderrBytes,
    ulimitKb: intEnv("IMPORT_SANDBOX_ULIMIT_KB", D.ulimitKb, 0),
    concurrency: intEnv("IMPORT_SANDBOX_CONCURRENCY", D.concurrency),
    queue: intEnv("IMPORT_SANDBOX_QUEUE", D.queue, 0),
    queueWaitMs: intEnv("IMPORT_SANDBOX_QUEUE_WAIT_MS", D.queueWaitMs),
  };
}

/** The switch. Anything but the exact string "true" means off. */
export const xlsxFlagOn = () => process.env.IMPORT_XLSX_ENABLED === "true";

// Where the child code lives. The app runs from its source folder (`next start`), so the working
// directory is the app root; if the files are not there, the importer fails closed.
const appRoot = () => process.cwd();
const childScript = () => path.join(appRoot(), "src", "lib", "import", "sandbox", "xlsx-child.mjs");
const probeScript = () =>
  path.join(appRoot(), "src", "lib", "import", "sandbox", "probe-child.mjs");
const allowRead = () => [
  path.join(appRoot(), "src", "lib", "import"),
  path.join(appRoot(), "node_modules"),
];
const spec = (script: string, extra: object = {}) => ({
  script,
  allowRead: allowRead(),
  cwd: appRoot(),
  limits: sandboxConfig(),
  ...extra,
});

type Cache = {
  checked?: { at: number; state: XlsxState; reason?: string };
  inflight?: Promise<{ state: XlsxState; reason?: string }>;
  limiter?: ReturnType<typeof createLimiter>;
  limiterKey?: string;
};
const g = globalThis as unknown as { tillflowXlsx?: Cache };
const cache = (): Cache => (g.tillflowXlsx ??= {});

/** Tests only: forget the self-test and the limiter. */
export function resetSandboxForTests() {
  g.tillflowXlsx = {};
}

async function note(level: "warn" | "info", fields: Record<string, unknown>, message: string) {
  try {
    const { logger } = await import("@/lib/logger");
    logger[level]({ job: "import-sandbox", ...fields }, message);
  } catch {
    // The logger is server-only and is not importable in some test setups; never fail a parse for it.
  }
}

/** What the self-test requires of this host before XLSX may run: every restriction, then a real parse. */
async function selfTest(): Promise<{ state: XlsxState; reason?: string }> {
  const fail = (reason: string) => ({ state: "unavailable" as const, reason });
  if (!fs.existsSync(childScript()))
    return fail("parser script not found under the working directory");
  if (!fs.existsSync(path.join(appRoot(), "node_modules", "exceljs")))
    return fail("exceljs not found under node_modules");

  const outside = fs.existsSync(path.join(appRoot(), "package.json"))
    ? path.join(appRoot(), "package.json")
    : process.execPath;
  const denied = await runSandboxed(
    spec(probeScript(), {
      args: ["deny", outside],
      allowRead: [path.dirname(probeScript())],
      limits: { ...sandboxConfig(), timeoutMs: 10_000 },
    }),
  );
  if (!denied.ok) return fail(`restriction check did not run (${denied.reason})`);
  let r: Record<string, string>;
  try {
    r = JSON.parse(denied.stdout.toString("utf8"));
  } catch {
    return fail("restriction check gave no answer");
  }
  const enforced = [
    "readOutside",
    "readDirOutside",
    "writeFile",
    "mkdir",
    "childProcess",
    "worker",
  ].every((k) => r[k] === "ERR_ACCESS_DENIED");
  if (!enforced) return fail("the Node permission model is not enforced on this host");
  const envNames = (r as unknown as { envNames?: string[] }).envNames ?? [];
  if (envNames.some((n) => /KEY|SECRET|TOKEN|PASS|DATABASE|SUPABASE|SMTP|URL/i.test(n))) {
    return fail("the parser process inherited secret-looking environment variables");
  }

  // A runaway child must really be stopped by the time limit, and be gone afterwards.
  const spin = await runSandboxed(
    spec(probeScript(), {
      args: ["spin"],
      allowRead: [path.dirname(probeScript())],
      limits: { ...sandboxConfig(), timeoutMs: 800 },
    }),
  );
  if (spin.ok || spin.reason !== "timeout" || (spin.pid && isAlive(spin.pid))) {
    return fail("a runaway child was not stopped by the time limit");
  }

  const parsed = await runSandboxed(spec(childScript(), { input: tinyWorkbook() }));
  if (!parsed.ok) {
    const code = (parsed.detail as { code?: number } | undefined)?.code;
    return fail(
      code === 97
        ? "a process limit (ulimit) could not be applied on this host"
        : `the parser did not run under the restrictions (${parsed.reason})`,
    );
  }
  if (process.platform === "linux" && parsed.peakRssMb === null) {
    return fail("the child's resident memory cannot be read on this host, so its ceiling would not work");
  }
  const answer = readAnswer(parsed.stdout);
  if (
    !answer ||
    !answer.ok ||
    JSON.stringify(answer.matrix) !== JSON.stringify(TINY_ROWS.slice(1))
  ) {
    return fail("the parser gave a wrong answer on the built-in workbook");
  }
  return { state: "ready" };
}

/**
 * disabled: flag off (nothing is started). ready: flag on and the self-test passed. unavailable: flag
 * on but this host failed the self-test; checked again after a minute. The result is per process.
 */
export async function xlsxStatus(): Promise<{ state: XlsxState; reason?: string }> {
  if (!xlsxFlagOn()) return { state: "disabled" };
  const c = cache();
  if (c.checked && (c.checked.state === "ready" || Date.now() - c.checked.at < 60_000)) {
    return { state: c.checked.state, reason: c.checked.reason };
  }
  c.inflight ??= selfTest()
    .catch((e: unknown) => ({
      state: "unavailable" as const,
      reason: `self-test crashed (${(e as { code?: string }).code ?? "error"})`,
    }))
    .then(async (result) => {
      c.checked = { at: Date.now(), ...result };
      c.inflight = undefined;
      await note(
        result.state === "ready" ? "info" : "warn",
        { state: result.state, reason: result.reason },
        "xlsx sandbox self-test",
      );
      return result;
    });
  return c.inflight;
}

/** What /api/health shows: the state without starting anything ("unchecked" until the first use). */
export function xlsxStatusPeek(): XlsxState | "unchecked" {
  if (!xlsxFlagOn()) return "disabled";
  return cache().checked?.state ?? "unchecked";
}

function limiter() {
  const c = cache();
  const cfg = sandboxConfig();
  const key = `${cfg.concurrency}/${cfg.queue}/${cfg.queueWaitMs}`;
  if (!c.limiter || c.limiterKey !== key) {
    c.limiter = createLimiter({ max: cfg.concurrency, queue: cfg.queue, waitMs: cfg.queueWaitMs });
    c.limiterKey = key;
  }
  return c.limiter;
}

/**
 * Reads the first sheet of an .xlsx in the isolated parser. Throws an ImportFileError for every
 * refusal; the rows it returns still go through the importer's own validation.
 */
export async function parseXlsxSandboxed(
  bytes: Buffer,
): Promise<{ headers: string[]; matrix: string[][] }> {
  const status = await xlsxStatus();
  if (status.state === "disabled") throw new ImportFileError("xlsx_disabled");
  if (status.state !== "ready") throw new ImportFileError("xlsx_unavailable");

  let outcome;
  try {
    outcome = await limiter().run(() => runSandboxed(spec(childScript(), { input: bytes })));
  } catch (e) {
    if ((e as { code?: string }).code === "busy") throw new ImportFileError("parser_busy");
    throw e;
  }

  if (!outcome.ok) {
    // Ids and numbers only: the child's stderr can echo the uploaded file, so it is never logged.
    await note(
      "warn",
      {
        reason: outcome.reason,
        ms: outcome.elapsedMs,
        peakRssMb: outcome.peakRssMb && Math.round(outcome.peakRssMb),
      },
      "xlsx parser stopped",
    );
    const limitFailed = outcome.reason === "exit" && (outcome.detail as { code?: number } | undefined)?.code === 97;
    if (outcome.reason === "spawn" || outcome.reason === "no-permission-model" || limitFailed) {
      cache().checked = undefined; // look at the host again next time
      throw new ImportFileError("xlsx_unavailable");
    }
    throw new ImportFileError("complex"); // timeout, memory, output, crash
  }

  const answer = readAnswer(outcome.stdout);
  if (!answer) {
    await note(
      "warn",
      { reason: "bad-output", bytes: outcome.stdout.length },
      "xlsx parser gave an invalid answer",
    );
    throw new ImportFileError("complex");
  }
  if (!answer.ok) throw new ImportFileError(answer.code);
  return { headers: answer.headers, matrix: answer.matrix };
}
