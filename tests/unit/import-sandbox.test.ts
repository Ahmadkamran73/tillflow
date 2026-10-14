// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ImportFileError } from "@/lib/import/errors";
import { parseUpload } from "@/lib/import/parse";
import {
  parseXlsxSandboxed,
  resetSandboxForTests,
  sandboxConfig,
  xlsxStatus,
  xlsxStatusPeek,
} from "@/lib/import/sandbox";
import { readAnswer } from "@/lib/import/sandbox/protocol";
import { createLimiter, isAlive, runSandboxed } from "@/lib/import/sandbox/runner.mjs";
import {
  colBomb,
  farRow,
  mergeBomb,
  tinyWorkbook,
  tooManyRows,
  TINY_ROWS,
} from "@/lib/import/sandbox/xlsx-fixtures.mjs";

// These start real child processes (the way production does), so they are slower than most tests.
vi.setConfig({ testTimeout: 90_000 });

const root = process.cwd();
const sandboxDir = path.join(root, "src", "lib", "import", "sandbox");
const probeScript = path.join(sandboxDir, "probe-child.mjs");
const run = (mode: string, arg?: string, limits: Record<string, number> = {}, input?: Buffer) =>
  runSandboxed({
    script: probeScript,
    allowRead: [sandboxDir],
    args: arg === undefined ? [mode] : [mode, arg],
    limits,
    input,
    cwd: root,
  });
const answerOf = (r: { ok: boolean; stdout?: Buffer }) =>
  JSON.parse(String(r.stdout)) as Record<string, unknown>;
const linux = process.platform === "linux";

const spawned: number[] = [];
const track = <T extends { pid?: number }>(r: T): T => (r.pid && spawned.push(r.pid), r);

/** True when the process is gone within a second. */
async function goneSoon(pid: number | undefined) {
  if (!pid) return true;
  for (let i = 0; i < 20; i++) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

afterAll(async () => {
  // Cleanup, for the whole file: nothing the tests started is still running.
  for (const pid of spawned) expect(await goneSoon(pid), `child ${pid} still alive`).toBe(true);
});

describe("runner: what a restricted child cannot do", () => {
  it("cannot read outside its folders, write, start processes or workers, or see the parent's secrets", async () => {
    process.env.TILLFLOW_TEST_SECRET = "must-not-reach-the-child";
    try {
      const r = track(await run("deny", path.join(root, "package.json")));
      expect(r.ok).toBe(true);
      const a = answerOf(r as never);
      expect(a.readOutside).toBe("ERR_ACCESS_DENIED");
      expect(a.readDirOutside).toBe("ERR_ACCESS_DENIED");
      expect(a.writeFile).toBe("ERR_ACCESS_DENIED");
      expect(a.mkdir).toBe("ERR_ACCESS_DENIED");
      expect(a.childProcess).toBe("ERR_ACCESS_DENIED");
      expect(a.worker).toBe("ERR_ACCESS_DENIED");
      expect(a.envNames).not.toContain("TILLFLOW_TEST_SECRET");
      // Nothing from the parent: only what the OS itself adds to a new process.
      const names = a.envNames as string[];
      expect(
        names.filter((n) => /KEY|SECRET|TOKEN|PASS|DATABASE|SUPABASE|SMTP|URL/i.test(n)),
      ).toEqual([]);
      // Not restricted by Node 24, reported honestly: the child has nothing to send instead.
      expect(a.network).toBe("ALLOWED");
    } finally {
      delete process.env.TILLFLOW_TEST_SECRET;
    }
  });

  it("really cannot create the file it tries to write", async () => {
    track(await run("deny", path.join(root, "package.json")));
    expect(fs.existsSync(path.join(root, "sandbox-write-test.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "sandbox-dir-test"))).toBe(false);
  });

  it("passes input in and answers out over the pipes", async () => {
    const r = track(await run("echo", undefined, {}, Buffer.alloc(5 * 1024 * 1024, 7)));
    expect(r.ok).toBe(true);
    expect(answerOf(r as never)).toEqual({ bytes: 5 * 1024 * 1024 });
  });
});

describe("runner: limits and clean termination", () => {
  it("kills a runaway loop at the time limit and leaves no process behind", async () => {
    const r = track(await run("spin", undefined, { timeoutMs: 1200 }));
    expect(r).toMatchObject({ ok: false, reason: "timeout" });
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1100);
    expect(r.elapsedMs).toBeLessThan(6000);
    expect(await goneSoon(r.pid)).toBe(true);
  });

  it("kills a child that writes without end once it passes the output limit", async () => {
    const r = track(await run("output", undefined, { outputBytes: 1024 * 1024 }));
    expect(r).toMatchObject({ ok: false, reason: "output" });
    expect(await goneSoon(r.pid)).toBe(true);
  });

  it("contains heap exhaustion in the child: it dies, we get an ordinary result", async () => {
    const r = track(await run("heap", undefined, { heapMb: 48 }));
    expect(r.ok).toBe(false);
    expect(["exit", "signal"]).toContain((r as { reason: string }).reason);
    expect(await goneSoon(r.pid)).toBe(true);
  });

  it("reports a child that crashes with its exit code, and a child that answers with garbage", async () => {
    const crash = track(await run("crash", "3"));
    expect(crash).toMatchObject({ ok: false, reason: "exit", detail: { code: 3 } });
    const garbage = track(await run("garbage"));
    expect(garbage.ok).toBe(true);
    expect(readAnswer((garbage as { stdout: Buffer }).stdout)).toBeNull();
  });

  it.skipIf(!linux)(
    "kills a child whose resident memory passes the ceiling (Buffers are outside the heap cap)",
    async () => {
      const r = track(await run("buffer", "1200", { rssMb: 256 }));
      expect(r).toMatchObject({ ok: false, reason: "rss" });
      expect(r.peakRssMb).toBeGreaterThan(256);
      expect(r.peakRssMb).toBeLessThan(900);
      expect(await goneSoon(r.pid)).toBe(true);
    },
  );

  it.skipIf(!linux)(
    "stops a Buffer hog at an address-space ceiling when `ulimit -v` is set",
    async () => {
      const r = track(await run("buffer", "3000", { ulimitKb: 2_500_000, rssMb: 100_000 }));
      // Either the child reports it could not allocate, or the runtime aborted: never all 3000 MB.
      if (r.ok) expect((answerOf(r as never).allocatedMb as number) < 3000).toBe(true);
      else expect(["exit", "signal"]).toContain(r.reason);
    },
  );

  it("refuses nonsense limits instead of passing them to a shell", () => {
    expect(() => run("echo", undefined, { heapMb: -1 })).toThrow();
    expect(() => run("echo", undefined, { timeoutMs: 0 })).toThrow();
    expect(() => run("echo", undefined, { ulimitKb: 1.5 })).toThrow();
    expect(() =>
      run("echo", undefined, { ulimitKb: "1; touch /tmp/x" as unknown as number }),
    ).toThrow();
  });

  it("leaves nothing running after a mix of failures", async () => {
    const results = await Promise.all([
      run("spin", undefined, { timeoutMs: 500 }),
      run("crash", "9"),
      run("heap", undefined, { heapMb: 32 }),
      run("output", undefined, { outputBytes: 100_000 }),
      run("sleep", "100"),
    ]);
    for (const r of results) track(r);
    for (const r of results) expect(await goneSoon(r.pid)).toBe(true);
  });
});

describe("limiter: bounded concurrency", () => {
  it("runs `max` at once, queues `queue`, and turns away the rest", async () => {
    const limiter = createLimiter({ max: 1, queue: 1, waitMs: 5000 });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = limiter.run(() => gate.then(() => "first"));
    const second = limiter.run(async () => "second");
    await expect(limiter.run(async () => "third")).rejects.toMatchObject({ code: "busy" });
    expect(limiter.stats()).toEqual({ active: 1, waiting: 1 });
    release();
    expect(await first).toBe("first");
    expect(await second).toBe("second");
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
  });

  it("gives up on a waiter after the wait limit and frees the slot when work throws", async () => {
    const limiter = createLimiter({ max: 1, queue: 2, waitMs: 50 });
    const held = limiter.run(() => new Promise<string>((r) => setTimeout(() => r("done"), 300)));
    await expect(limiter.run(async () => "late")).rejects.toMatchObject({ code: "busy" });
    expect(await held).toBe("done");
    await expect(
      limiter.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(limiter.stats()).toEqual({ active: 0, waiting: 0 });
    expect(await limiter.run(async () => "after")).toBe("after");
  });
});

describe("boundary: the parent accepts one exact shape from the child", () => {
  const ok = { ok: true, headers: ["Name", "Price"], matrix: [["Tea", "3"]] };
  const parse = (v: unknown) =>
    readAnswer(Buffer.from(typeof v === "string" ? v : JSON.stringify(v)));

  it("accepts a well-formed answer and a well-formed refusal", () => {
    expect(parse(ok)).toEqual(ok);
    expect(parse({ ok: false, code: "rows" })).toEqual({ ok: false, code: "rows" });
    expect(parse({ ok: true, headers: [], matrix: [] })).toMatchObject({ ok: true });
  });

  it.each([
    ["not JSON", "this is not json"],
    ["empty output", ""],
    ["an array", []],
    ["a missing field", { ok: true, headers: ["a"] }],
    ["an extra key", { ...ok, secret: "x" }],
    ["a refusal with an unknown code", { ok: false, code: "pwned" }],
    ["a refusal with an extra key", { ok: false, code: "rows", note: "x" }],
    ["non-string cells", { ok: true, headers: ["a"], matrix: [[1]] }],
    ["nested cells", { ok: true, headers: ["a"], matrix: [[["x"]]] }],
    ["rows wider than the header", { ok: true, headers: ["a"], matrix: [["x", "y"]] }],
    ["rows narrower than the header", { ok: true, headers: ["a", "b"], matrix: [["x"]] }],
    ["a cell over the Excel limit", { ok: true, headers: ["a"], matrix: [["x".repeat(32_768)]] }],
    ["more than 61 header cells", { ok: true, headers: Array(62).fill("h"), matrix: [] }],
    ["more than 50,000 rows", { ok: true, headers: ["a"], matrix: Array(50_001).fill(["x"]) }],
    ["ok as a string", { ok: "true", headers: [], matrix: [] }],
  ])("rejects %s", (_label, value) => {
    expect(parse(value)).toBeNull();
  });
});

describe("Excel import is off by default", () => {
  afterEach(() => {
    delete process.env.IMPORT_XLSX_ENABLED;
    resetSandboxForTests();
  });

  it("refuses with a clear code and starts nothing, whatever the file", async () => {
    delete process.env.IMPORT_XLSX_ENABLED;
    resetSandboxForTests();
    expect(await xlsxStatus()).toEqual({ state: "disabled" });
    expect(xlsxStatusPeek()).toBe("disabled");
    const err = await parseUpload("a.xlsx", tinyWorkbook()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportFileError);
    expect((err as ImportFileError).code).toBe("xlsx_disabled");
  });

  it.each(["TRUE", "1", "yes", "false", " true", ""])(
    "is still off when the flag is %j (only the exact string true turns it on)",
    async (value) => {
      process.env.IMPORT_XLSX_ENABLED = value;
      resetSandboxForTests();
      expect((await xlsxStatus()).state).toBe("disabled");
      await expect(parseUpload("a.xlsx", tinyWorkbook())).rejects.toMatchObject({
        code: "xlsx_disabled",
      });
    },
  );

  it("starts ON for staging only (still gated by the self-test), never for production or an unset environment", async () => {
    const was = process.env.NEXT_PUBLIC_APP_ENV;
    try {
      delete process.env.IMPORT_XLSX_ENABLED;
      for (const [env, expected] of [
        ["staging", "unchecked"],
        ["production", "disabled"],
        ["development", "disabled"],
        ["Staging", "disabled"],
        [undefined, "disabled"],
      ] as const) {
        if (env === undefined) delete process.env.NEXT_PUBLIC_APP_ENV;
        else process.env.NEXT_PUBLIC_APP_ENV = env;
        resetSandboxForTests();
        expect(xlsxStatusPeek(), String(env)).toBe(expected);
      }
      // An explicit false beats the staging default; an explicit true works anywhere.
      process.env.NEXT_PUBLIC_APP_ENV = "staging";
      process.env.IMPORT_XLSX_ENABLED = "false";
      resetSandboxForTests();
      expect(xlsxStatusPeek()).toBe("disabled");
      process.env.NEXT_PUBLIC_APP_ENV = "production";
      process.env.IMPORT_XLSX_ENABLED = "true";
      resetSandboxForTests();
      expect(xlsxStatusPeek()).toBe("unchecked");
    } finally {
      if (was === undefined) delete process.env.NEXT_PUBLIC_APP_ENV;
      else process.env.NEXT_PUBLIC_APP_ENV = was;
    }
  });

  it("leaves CSV and JSON working while Excel is off", async () => {
    delete process.env.IMPORT_XLSX_ENABLED;
    resetSandboxForTests();
    expect((await parseUpload("a.csv", Buffer.from("Name,Price\nTea,3"))).rows).toEqual([
      { Name: "Tea", Price: "3" },
    ]);
    expect(
      (await parseUpload("a.json", Buffer.from('[{"Name":"Tea","Price":3}]'))).rows,
    ).toHaveLength(1);
  });

  it("fails closed, with no in-process fallback, when the host cannot run the parser", async () => {
    process.env.IMPORT_XLSX_ENABLED = "true";
    resetSandboxForTests();
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(os.tmpdir()); // the parser files are not there
    try {
      const status = await xlsxStatus();
      expect(status.state).toBe("unavailable");
      expect(status.reason).toMatch(/not found/);
      await expect(parseUpload("a.xlsx", tinyWorkbook())).rejects.toMatchObject({
        code: "xlsx_unavailable",
      });
      expect(xlsxStatusPeek()).toBe("unavailable");
    } finally {
      cwd.mockRestore();
    }
  });
});

describe("Excel import through the isolated parser", () => {
  beforeAll(() => {
    process.env.IMPORT_XLSX_ENABLED = "true";
    resetSandboxForTests();
  });
  afterAll(() => {
    delete process.env.IMPORT_XLSX_ENABLED;
    resetSandboxForTests();
  });

  const refusal = async (bytes: Buffer) => {
    const e = await parseXlsxSandboxed(bytes).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ImportFileError);
    return (e as ImportFileError).code;
  };

  it("passes its self-test on this host and reads a small workbook", async () => {
    expect(await xlsxStatus()).toEqual({ state: "ready" });
    expect(xlsxStatusPeek()).toBe("ready");
    const { headers, matrix } = await parseXlsxSandboxed(tinyWorkbook());
    expect(headers).toEqual(TINY_ROWS[0]);
    expect(matrix).toEqual(TINY_ROWS.slice(1));
  });

  it("reads a workbook written by ExcelJS with hyperlinks, a table, a comment and a picture", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Products");
    sheet.addRow(["Name", "Price", "Link"]);
    sheet.addRow(["Tea", 3.5, { text: "site", hyperlink: "https://example.com" }]);
    sheet.getCell("A2").note = "a note";
    sheet.addTable({
      name: "T1",
      ref: "A5",
      headerRow: true,
      columns: [{ name: "a" }],
      rows: [[1]],
    });
    const parsed = await parseUpload("rich.xlsx", Buffer.from(await book.xlsx.writeBuffer()));
    expect(parsed.rows[0]).toEqual({ Name: "Tea", Price: "3.5", Link: "site" });
  });

  it("stops the two ExcelJS amplification bombs inside the child and keeps serving", async () => {
    // A few hundred bytes of XML each; ExcelJS would allocate gigabytes of cell and column objects.
    for (const bomb of [mergeBomb(), colBomb()]) {
      expect(bomb.length).toBeLessThan(3000);
      const started = Date.now();
      expect(await refusal(bomb)).toBe("complex");
      expect(Date.now() - started).toBeLessThan(30_000);
      // The web server process is fine and the next upload works.
      expect((await parseXlsxSandboxed(tinyWorkbook())).matrix).toEqual(TINY_ROWS.slice(1));
    }
  });

  it("refuses a sheet with too many rows, or a row far out of range", async () => {
    expect(await refusal(tooManyRows())).toBe("rows");
    expect(await refusal(farRow())).toBe("rows");
  });

  it("refuses a hostile archive with the reader's code, not a crash", async () => {
    expect(await refusal(Buffer.concat([Buffer.alloc(64, 0x41), tinyWorkbook()]))).toBe(
      "unreadable",
    );
    expect(await refusal(Buffer.from("PK\u0003\u0004 not really a zip"))).toBe("unreadable");
  });

  it("turns a parse that runs out of time into 'complex' (limit read from the environment)", async () => {
    await xlsxStatus(); // self-test with the normal limits first
    process.env.IMPORT_SANDBOX_TIMEOUT_MS = "150";
    try {
      expect(sandboxConfig().timeoutMs).toBe(150);
      expect(await refusal(tinyWorkbook())).toBe("complex");
    } finally {
      delete process.env.IMPORT_SANDBOX_TIMEOUT_MS;
    }
    expect((await parseXlsxSandboxed(tinyWorkbook())).headers).toEqual(TINY_ROWS[0]);
  });

  it("turns away uploads beyond the concurrency and queue limits as 'parser_busy'", async () => {
    await xlsxStatus();
    process.env.IMPORT_SANDBOX_CONCURRENCY = "1";
    process.env.IMPORT_SANDBOX_QUEUE = "1";
    try {
      const results = await Promise.allSettled([
        parseXlsxSandboxed(tinyWorkbook()),
        parseXlsxSandboxed(tinyWorkbook()),
        parseXlsxSandboxed(tinyWorkbook()),
      ]);
      const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(failed).toHaveLength(1);
      expect((failed[0]?.reason as ImportFileError).code).toBe("parser_busy");
    } finally {
      delete process.env.IMPORT_SANDBOX_CONCURRENCY;
      delete process.env.IMPORT_SANDBOX_QUEUE;
    }
  });

  it("reads limits from the environment and ignores nonsense", () => {
    process.env.IMPORT_SANDBOX_HEAP_MB = "128";
    process.env.IMPORT_SANDBOX_RSS_MB = "abc";
    process.env.IMPORT_SANDBOX_OUTPUT_BYTES = "-5";
    try {
      const cfg = sandboxConfig();
      expect(cfg.heapMb).toBe(128);
      expect(cfg.rssMb).toBe(768);
      expect(cfg.outputBytes).toBe(40 * 1024 * 1024);
    } finally {
      delete process.env.IMPORT_SANDBOX_HEAP_MB;
      delete process.env.IMPORT_SANDBOX_RSS_MB;
      delete process.env.IMPORT_SANDBOX_OUTPUT_BYTES;
    }
  });
});

describe("no in-process Excel parsing", () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });

  it("only the template and report writers and the sandboxed reader import ExcelJS; the app's parser does not touch it", () => {
    const users = walk(path.join(root, "src"))
      .filter((f) => /\.(ts|tsx|mjs|js)$/.test(f))
      .filter((f) =>
        /from\s+["']exceljs["']|require\(["']exceljs["']\)|import\(["']exceljs["']\)/.test(
          fs.readFileSync(f, "utf8"),
        ),
      )
      .map((f) => path.relative(root, f).split(path.sep).join("/"))
      .sort();
    expect(users).toEqual([
      "src/app/api/v1/imports/template/route.ts",
      "src/lib/export/tabular.ts",
      "src/lib/import/sandbox/xlsx-read.mjs",
    ]);
    // The report writer only writes workbooks it builds itself; it never opens a file.
    const tabular = fs.readFileSync(path.join(root, "src/lib/export/tabular.ts"), "utf8");
    expect(tabular).not.toMatch(/xlsx\.(load|read)|readFile/);
    const parse = fs.readFileSync(path.join(root, "src/lib/import/parse.ts"), "utf8");
    expect(parse).not.toMatch(/xlsx-read|xlsx-zip|exceljs/i);
  });
});

describe("children do not outlive the app", () => {
  // On Windows libuv already ends children with their parent, so this passes there with or without
  // our exit hook; it only proves the hook on Linux (the production platform). The Linux result is
  // recorded in docs/specs/bulk-import.md (run in a container, hook on: gone; hook off: orphaned).
  it("kills a running child when the parent process exits", async () => {
    const { spawnSync } = await import("node:child_process");
    const { pathToFileURL } = await import("node:url");
    const runner = pathToFileURL(path.join(sandboxDir, "runner.mjs")).href;
    // A throwaway parent: starts a child that spins for a minute, then exits after 300 ms.
    const parent = `
      import { runSandboxed } from ${JSON.stringify(runner)};
      runSandboxed({
        script: ${JSON.stringify(probeScript)},
        allowRead: [${JSON.stringify(sandboxDir)}],
        args: ["spin"],
        limits: { timeoutMs: 60000 },
        onSpawn: (pid) => { console.log("pid=" + pid); setTimeout(() => process.exit(0), 300); },
      });
    `;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", parent], {
      encoding: "utf8",
      timeout: 30_000,
    });
    const pid = Number(/pid=(\d+)/.exec(out.stdout)?.[1]);
    expect(pid).toBeGreaterThan(0);
    spawned.push(pid);
    expect(await goneSoon(pid), "the child kept running after its parent exited").toBe(true);
  });

  it.skipIf(!linux)(
    "ends a spinning child at its CPU-time limit, well before the wall-clock timeout",
    async () => {
      const r = track(await run("spin", undefined, { timeoutMs: 20_000, cpuSeconds: 2 } as never));
      expect(r.ok).toBe(false);
      expect((r as { reason: string }).reason).not.toBe("timeout");
      expect(r.elapsedMs).toBeLessThan(10_000);
      expect(await goneSoon(r.pid)).toBe(true);
    },
  );

  it("rejects a CPU limit that is not a whole number of seconds", () => {
    if (!linux) return; // the limit only exists where the shell wrapper is used
    expect(() => run("spin", undefined, { cpuSeconds: 1.5 } as never)).toThrow();
    expect(() => run("spin", undefined, { cpuSeconds: -3 } as never)).toThrow();
  });
});

describe("routes that re-read the stored upload are rate limited", () => {
  it.each(["preview", "errors"])(
    "the %s route counts every request against the shop's import-reparse budget",
    (name) => {
      const source = fs.readFileSync(
        path.join(root, "src", "app", "api", "v1", "imports", "[id]", name, "route.ts"),
        "utf8",
      );
      const limitAt = source.indexOf('rateLimit("import-reparse"');
      expect(limitAt).toBeGreaterThan(0);
      // after authorization, before the file is read and parsed
      expect(source.indexOf("authorizeApi(")).toBeLessThan(limitAt);
      expect(limitAt).toBeLessThan(source.indexOf("analyse("));
    },
  );
});
