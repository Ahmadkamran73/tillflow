// Starts a script in a separate, restricted Node process and supervises it. Plain Node on purpose:
// the app imports it, and the probe runs the same file under bare `node` on a Linux host.
//
// What a child gets:
//   - its own V8 heap cap (--max-old-space-size): heap exhaustion ends only the child
//   - Node's permission model (--permission): no child processes, no workers, no file writes, and
//     file reads only from the folders in `allowRead`. It does NOT restrict the network: Node 24
//     has no switch for that, so the child gets an empty environment and no credentials instead
//   - an empty environment, no database access, no session: nothing to steal or call
//   - a wall-clock timeout, a resident-memory ceiling (polled every 50 ms from /proc on Linux, so a
//     child can overshoot it between polls; heap flags do not bound Buffers) and an output ceiling,
//     each enforced by the parent with SIGKILL
//   - on Linux with /bin/sh: a CPU-time limit (`ulimit -t`, wall timeout + 5 s) that ends a child
//     even if the parent is gone, and, if `ulimitKb` is set, an address-space ceiling (`ulimit -v`).
//     The wrapper fails closed: if either limit cannot be applied the child exits with code 97
//   - every live child is killed when the parent process exits
import { spawn } from "node:child_process";
import fs from "node:fs";
import { SANDBOX_DEFAULTS } from "../limits.mjs";

/**
 * The Node flag that turns the permission model on, or null when this Node has none. Only the stable
 * `--permission` (Node 22.13+ / 23.5+) counts: the older experimental flag is not relied on.
 */
export function permissionFlag() {
  return process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : null;
}

// Children that are running, so they can be killed if this process exits (a restart or deploy while a
// parse runs must not leave a child behind). SIGKILL/crash of the parent cannot be hooked; the CPU
// limit above is the backstop for that.
const live = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const child of live) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  });
}

/** Resident memory of a process in MB, from /proc (Linux), or null where that is not available. */
export function readRssMb(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const m = /VmRSS:\s+(\d+) kB/.exec(status);
    return m ? Number(m[1]) / 1024 : null;
  } catch {
    return null;
  }
}

/** Whether a process id is still alive (signal 0 only checks). */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/**
 * @typedef {{ timeoutMs: number, heapMb: number, rssMb: number, outputBytes: number, stderrBytes: number, ulimitKb: number }} Limits
 * @typedef {{
 *   ok: true, stdout: Buffer, pid: number, elapsedMs: number, peakRssMb: number | null, stderrTail: string
 * } | {
 *   ok: false,
 *   reason: "no-permission-model" | "spawn" | "timeout" | "rss" | "output" | "exit" | "signal",
 *   pid?: number, elapsedMs: number, peakRssMb: number | null, stderrTail: string, detail?: unknown
 * }} Outcome
 */

/**
 * Runs `script` in a restricted child, feeds it `input` on stdin and returns what it wrote to stdout.
 * Every failure is an Outcome with a reason (only bad limits throw). Normally the child is dead when this resolves; the one exception is the 3 s failsafe below, which fires only if SIGKILL did not end it.
 * @param {{ script: string, allowRead: string[], input?: Buffer, args?: string[], limits?: Partial<Limits> & { cpuSeconds?: number }, cwd?: string, onSpawn?: (pid: number) => void }} spec
 * @returns {Promise<Outcome>}
 */
export function runSandboxed({
  script,
  allowRead,
  input = Buffer.alloc(0),
  args = [],
  limits = {},
  cwd,
  onSpawn,
}) {
  const L = { ...SANDBOX_DEFAULTS, ...limits };
  const started = Date.now();
  const flag = permissionFlag();
  if (!flag) {
    return Promise.resolve({
      ok: false,
      reason: "no-permission-model",
      elapsedMs: 0,
      peakRssMb: null,
      stderrTail: "",
    });
  }
  for (const key of ["timeoutMs", "heapMb", "rssMb", "outputBytes", "stderrBytes"]) {
    if (!Number.isFinite(L[key]) || L[key] <= 0) throw new Error(`bad sandbox limit ${key}`);
  }
  if (!Number.isInteger(L.ulimitKb) || L.ulimitKb < 0)
    throw new Error("bad sandbox limit ulimitKb");

  const nodeArgs = [
    `--max-old-space-size=${Math.floor(L.heapMb)}`,
    flag,
    ...allowRead.map((p) => `--allow-fs-read=${p}`),
    script,
    ...args,
  ];
  let command = process.execPath;
  let argv = nodeArgs;
  if (process.platform === "linux" && fs.existsSync("/bin/sh")) {
    // The only interpolated values are integers checked here. A limit that cannot be applied makes
    // the child exit with 97 instead of running without it. `exec` replaces the shell, so the pid
    // we watch is node's own.
    const cpu = L.cpuSeconds ?? Math.ceil(L.timeoutMs / 1000) + 5;
    if (!Number.isInteger(cpu) || cpu <= 0) throw new Error("bad sandbox limit cpuSeconds");
    const vm = L.ulimitKb > 0 ? `ulimit -v ${L.ulimitKb} || exit 97; ` : "";
    command = "/bin/sh";
    argv = [
      "-c",
      `ulimit -t ${cpu} || exit 97; ${vm}exec "$0" "$@"`,
      process.execPath,
      ...nodeArgs,
    ];
  }
  const env =
    process.platform === "win32" && process.env.SystemRoot
      ? { SystemRoot: process.env.SystemRoot }
      : {};

  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const out = [];
    let outBytes = 0;
    let errTail = "";
    let peak = /** @type {number | null} */ (null);
    let killedFor = /** @type {"timeout" | "rss" | "output" | null} */ (null);
    let settled = false;

    let child;
    try {
      child = spawn(command, argv, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        ok: false,
        reason: "spawn",
        elapsedMs: 0,
        peakRssMb: null,
        stderrTail: "",
        detail: error.code ?? "throw",
      });
      return;
    }
    const pid = child.pid ?? 0;
    hookExit();
    live.add(child);
    onSpawn?.(pid);

    const kill = (/** @type {"timeout" | "rss" | "output"} */ why) => {
      if (killedFor) return;
      killedFor = why;
      child.kill("SIGKILL");
      // SIGKILL cannot be ignored; this only protects the caller from a runtime that never closes pipes.
      failsafe = setTimeout(
        () =>
          settle({
            ok: false,
            reason: why,
            pid,
            elapsedMs: Date.now() - started,
            peakRssMb: peak,
            stderrTail: errTail,
          }),
        3000,
      );
    };
    /** @type {NodeJS.Timeout | undefined} */
    let failsafe;
    const timer = setTimeout(() => kill("timeout"), L.timeoutMs);
    const poll = setInterval(() => {
      const rss = readRssMb(pid);
      if (rss === null) return;
      peak = Math.max(peak ?? 0, rss);
      if (rss > L.rssMb) kill("rss");
    }, 50);

    /** @param {Outcome} outcome */
    function settle(outcome) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (failsafe) clearTimeout(failsafe);
      resolve(outcome);
    }

    child.stdout.on("data", (chunk) => {
      outBytes += chunk.length;
      if (outBytes > L.outputBytes) return kill("output");
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errTail.length < L.stderrBytes)
        errTail += chunk.toString("utf8", 0, L.stderrBytes - errTail.length);
    });
    child.stdin.on("error", () => {}); // the child may exit before it has read everything
    child.on("error", (error) =>
      settle({
        ok: false,
        reason: "spawn",
        elapsedMs: Date.now() - started,
        peakRssMb: peak,
        stderrTail: errTail,
        detail: error.code ?? "error",
      }),
    );
    child.on("close", (code, signal) => {
      live.delete(child);
      const base = { pid, elapsedMs: Date.now() - started, peakRssMb: peak, stderrTail: errTail };
      if (killedFor) return settle({ ok: false, reason: killedFor, ...base });
      if (code === 0) return settle({ ok: true, stdout: Buffer.concat(out), ...base });
      return settle({
        ok: false,
        reason: signal ? "signal" : "exit",
        ...base,
        detail: { code, signal },
      });
    });

    child.stdin.end(input);
  });
}

/**
 * At most `max` things at once and `queue` waiting, each for no longer than `waitMs`. A caller that
 * cannot get a slot gets an Error with code "busy" instead of piling work onto the host.
 * @param {{ max: number, queue: number, waitMs: number }} o
 */
export function createLimiter({ max, queue, waitMs }) {
  let active = 0;
  /** @type {{ go: () => void, timer: NodeJS.Timeout }[]} */
  const waiting = [];
  const busy = () => Object.assign(new Error("busy"), { code: "busy" });

  function release() {
    active -= 1;
    const next = waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      active += 1;
      next.go();
    }
  }
  function acquire() {
    if (active < max) {
      active += 1;
      return Promise.resolve();
    }
    if (waiting.length >= queue) return Promise.reject(busy());
    return new Promise((resolve, reject) => {
      const entry = {
        go: resolve,
        timer: setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          reject(busy());
        }, waitMs),
      };
      waiting.push(entry);
    });
  }
  return {
    /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
    async run(fn) {
      await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },
    stats: () => ({ active, waiting: waiting.length }),
  };
}
