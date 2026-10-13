// Measures what the sandbox ACTUALLY enforces on the machine it runs on, by making a misbehaving
// child try each forbidden thing and watching what happens. Intended limits are not evidence;
// this is. Run it on the real host before turning XLSX on:
//   - automatically at boot:  IMPORT_SANDBOX_PROBE_ON_BOOT=true  (result goes to the application log)
//   - by hand on a Linux box:  node src/lib/import/sandbox/probe.mjs [--root <app folder>]
// Plain Node (no TypeScript, no bundler), so the same file runs anywhere the app runs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_DEFAULTS } from "../limits.mjs";
import { isAlive, permissionFlag, runSandboxed } from "./runner.mjs";
import { mergeBomb, tinyWorkbook, TINY_ROWS } from "./xlsx-fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

const readText = (file) => {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
};

/** What the host says about its own limits (Linux cgroups and /proc); null where unreadable. */
function hostFacts() {
  const limitsText = readText("/proc/self/limits");
  const line = (name) =>
    limitsText
      ?.split("\n")
      .find((l) => l.startsWith(name))
      ?.replace(/\s+/g, " ") ?? null;
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.cpus().length,
    totalMemMb: Math.round(os.totalmem() / 1048576),
    freeMemMb: Math.round(os.freemem() / 1048576),
    constrainedMemoryMb:
      typeof process.constrainedMemory === "function"
        ? Math.round(process.constrainedMemory() / 1048576) || null
        : null,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    cgroupMemoryMax:
      readText("/sys/fs/cgroup/memory.max") ??
      readText("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
    cgroupPidsMax: readText("/sys/fs/cgroup/pids.max") ?? readText("/sys/fs/cgroup/pids/pids.max"),
    cgroupCpuMax: readText("/sys/fs/cgroup/cpu.max"),
    procLimits: {
      maxProcesses: line("Max processes"),
      maxAddressSpace: line("Max address space"),
      maxOpenFiles: line("Max open files"),
    },
    shellAvailable: process.platform === "linux" && fs.existsSync("/bin/sh"),
    permissionFlag: permissionFlag(),
  };
}

const brief = (r) =>
  r.ok
    ? { ok: true, ms: r.elapsedMs, peakRssMb: round(r.peakRssMb) }
    : {
        ok: false,
        reason: r.reason,
        ms: r.elapsedMs,
        peakRssMb: round(r.peakRssMb),
        detail: r.detail ?? null,
      };
const round = (n) => (n === null || n === undefined ? null : Math.round(n));
const json = (r) => {
  try {
    return r.ok ? JSON.parse(r.stdout.toString("utf8")) : null;
  } catch {
    return null;
  }
};

/**
 * @param {{ root?: string, limits?: Record<string, number>, log?: (line: string) => void }} [o]
 *   root: the application folder (where node_modules is). Default: three folders above src/lib/import/sandbox.
 */
export async function runProbe({
  root = path.resolve(here, "..", "..", "..", ".."),
  limits = {},
  log = () => {},
} = {}) {
  const L = { ...SANDBOX_DEFAULTS, ...limits };
  const importDir = path.join(root, "src", "lib", "import");
  const probeChild = path.join(here, "probe-child.mjs");
  const xlsxChild = path.join(here, "xlsx-child.mjs");
  const allowProbe = [here];
  const allowXlsx = [importDir, path.join(root, "node_modules")];
  const probeRun = (mode, arg, over = {}, input) =>
    runSandboxed({
      script: probeChild,
      allowRead: allowProbe,
      args: arg === undefined ? [mode] : [mode, String(arg)],
      limits: { ...L, ...over },
      input,
      cwd: root,
    });

  /** @type {{ when: string, configured: object, host: ReturnType<typeof hostFacts>, checks: Record<string, any>, enforced: Record<string, any>, notes: string[], requiredFailed: string[], verdict: string }} */
  const report = {
    when: new Date().toISOString(),
    configured: L,
    host: hostFacts(),
    checks: {},
    enforced: {},
    notes: [],
    requiredFailed: [],
    verdict: "unknown",
  };
  const step = (name, value) => {
    report.checks[name] = value;
    log(`probe ${name}: ${JSON.stringify(value)}`);
  };

  // 1) Permission model: filesystem, child processes, workers, environment
  process.env.TILLFLOW_PROBE_SECRET = "must-not-reach-the-child";
  const outsideFile = fs.existsSync(path.join(root, "package.json"))
    ? path.join(root, "package.json")
    : process.execPath;
  const denyRun = await probeRun("deny", outsideFile);
  const deny = json(denyRun);
  step("deny", deny ? { ...deny, run: brief(denyRun) } : brief(denyRun));
  delete process.env.TILLFLOW_PROBE_SECRET;
  const denied = (v) => v === "ERR_ACCESS_DENIED";
  report.enforced.fsReadOutsideDenied = deny
    ? denied(deny.readOutside) && denied(deny.readDirOutside)
    : false;
  report.enforced.fsWriteDenied = deny ? denied(deny.writeFile) && denied(deny.mkdir) : false;
  report.enforced.childProcessDenied = deny ? denied(deny.childProcess) : false;
  report.enforced.workerDenied = deny ? denied(deny.worker) : false;
  report.enforced.parentSecretsNotInherited = deny
    ? !deny.envNames.includes("TILLFLOW_PROBE_SECRET")
    : false;
  report.enforced.heapCapMb = deny ? deny.heapSizeLimitMb : null;
  // Node's permission model has no network switch. Said here so nobody reads silence as safety.
  report.enforced.networkBlocked = false;
  report.notes.push(
    "Network access is NOT restricted by Node's permission model; the child has an empty environment, no credentials and no database access instead.",
  );

  // 2) Heap exhaustion ends only the child (small heap so the probe itself stays light)
  const heap = await probeRun("heap", undefined, { heapMb: 64, timeoutMs: 20_000 });
  step("heapBomb", brief(heap));
  report.enforced.heapExhaustionContained =
    !heap.ok && heap.reason !== "timeout" && !isAlive(heap.pid ?? 0);

  // 3) Wall-clock timeout
  const spin = await probeRun("spin", undefined, { timeoutMs: 1500 });
  step("timeout", { ...brief(spin), aliveAfter: isAlive(spin.pid ?? 0) });
  report.enforced.timeoutKills = !spin.ok && spin.reason === "timeout" && !isAlive(spin.pid ?? 0);

  // 4) Output ceiling
  const output = await probeRun("output", undefined, { outputBytes: 1024 * 1024 });
  step("outputCap", brief(output));
  report.enforced.outputCapKills = !output.ok && output.reason === "output";

  // 5) Resident-memory ceiling (needs /proc, so Linux). Buffers are outside the heap cap.
  if (process.platform === "linux") {
    const rssLimit = 256;
    const buf = await probeRun("buffer", 1200, { rssMb: rssLimit });
    step("rssCap", {
      limitMb: rssLimit,
      ...brief(buf),
      overshootMb: buf.peakRssMb ? round(buf.peakRssMb - rssLimit) : null,
    });
    report.enforced.rssCapKills = !buf.ok && buf.reason === "rss";
  } else {
    step("rssCap", {
      skipped: `resident-memory polling needs /proc (platform: ${process.platform})`,
    });
    report.enforced.rssCapKills = null;
    report.notes.push(
      "On this platform nothing bounds the child's non-heap memory except what the xlsx reader's own caps do.",
    );
  }

  // 6) Process limits applied through `sh` (Linux): a CPU-time ceiling that ends a runaway child even
  // if the parent is gone, and an optional address-space ceiling (`ulimit -v`). Both fail closed:
  // a limit that cannot be set makes the child exit with 97.
  if (report.host.shellAvailable) {
    // CPU time: a spinning child with a long wall timeout must be ended by the CPU limit first.
    const cpu = await probeRun("spin", undefined, { timeoutMs: 15_000, cpuSeconds: 2 });
    step("cpuLimit", { limitSeconds: 2, ...brief(cpu), aliveAfter: isAlive(cpu.pid ?? 0) });
    report.enforced.cpuLimitKills =
      !cpu.ok && cpu.reason !== "timeout" && cpu.elapsedMs < 10_000 && !isAlive(cpu.pid ?? 0);

    // Address space. The cap is chosen so that, if it works, the allocation fails near 700 MB; if it
    // does NOT work, the resident-memory kill (900 MB, left on) ends the child. The probe therefore
    // never lets a child pass about 900 MB, and it is skipped on a host that reports less than 2 GB.
    const constrained = report.host.constrainedMemoryMb;
    if (constrained !== null && constrained < 2048) {
      step("ulimitAddressSpace", { skipped: `the host reports only ${constrained} MB of memory` });
      report.enforced.ulimitCapWorks = null;
    } else {
      const cap = 2_200_000; // KB; Node itself needs ~1.5 GB of address space to start
      const u = await probeRun("buffer", 1200, { ulimitKb: cap, rssMb: 900, timeoutMs: 20_000 });
      const answer = json(u);
      step("ulimitAddressSpace", { limitKb: cap, ...brief(u), childAnswer: answer });
      // Works = the allocation failed by itself (answer with an error, or the runtime aborted), and the
      // resident-memory kill did NOT have to step in. Exit 97 = the shell could not apply the limit.
      report.enforced.ulimitCapWorks = u.ok
        ? Boolean(answer && answer.error !== null && answer.allocatedMb < 1200)
        : u.reason !== "rss" && u.detail?.code !== 97;
    }
  } else {
    step("cpuLimit", { skipped: "needs Linux and /bin/sh" });
    step("ulimitAddressSpace", { skipped: "needs Linux and /bin/sh" });
    report.enforced.cpuLimitKills = null;
    report.enforced.ulimitCapWorks = null;
  }

  // 7) The real parser, end to end under the configured limits
  if (fs.existsSync(path.join(root, "node_modules", "exceljs"))) {
    const xlsx = (bytes, over = {}) =>
      runSandboxed({
        script: xlsxChild,
        allowRead: allowXlsx,
        input: bytes,
        limits: { ...L, ...over },
        cwd: root,
      });
    const tiny = await xlsx(tinyWorkbook());
    const parsed = json(tiny);
    const right =
      parsed?.ok === true && JSON.stringify(parsed.matrix) === JSON.stringify(TINY_ROWS.slice(1));
    step("xlsxParse", { ...brief(tiny), correct: right });
    report.enforced.xlsxParsesUnderRestrictions = right;

    // The hostile sheet from the review: a few hundred bytes of XML that ExcelJS expands into gigabytes.
    const bomb = await xlsx(mergeBomb());
    step("mergeCellBomb", {
      ...brief(bomb),
      aliveAfter: isAlive(bomb.pid ?? 0),
      bytesIn: mergeBomb().length,
    });
    report.enforced.amplificationBombContained = !bomb.ok && !isAlive(bomb.pid ?? 0);
  } else {
    step("xlsxParse", { skipped: "exceljs is not installed under the root" });
    report.enforced.xlsxParsesUnderRestrictions = null;
    report.enforced.amplificationBombContained = null;
  }

  // What must hold before XLSX may be switched on in production.
  const required = [
    "fsReadOutsideDenied",
    "fsWriteDenied",
    "childProcessDenied",
    "workerDenied",
    "parentSecretsNotInherited",
    "heapExhaustionContained",
    "timeoutKills",
    "outputCapKills",
    "xlsxParsesUnderRestrictions",
    "amplificationBombContained",
    // On Linux these are what bound memory and orphaned children; elsewhere they cannot exist.
    ...(process.platform === "linux" ? ["rssCapKills", "cpuLimitKills"] : []),
  ];
  report.requiredFailed = required.filter((k) => report.enforced[k] !== true);
  report.verdict = report.requiredFailed.length === 0 ? "isolation-enforced" : "NOT-enforced";
  return report;
}

// `node probe.mjs [--root dir]`: print the report and exit non-zero if a required control failed.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = i > 0 ? path.resolve(process.argv[i + 1] ?? ".") : undefined;
  const report = await runProbe({ root });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.verdict === "isolation-enforced" ? 0 : 1);
}
