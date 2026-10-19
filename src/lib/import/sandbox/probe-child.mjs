// A deliberately misbehaving child, run ONLY by the tests and by the probe (probe.mjs) to check that
// the sandbox really contains each kind of failure on the host it runs on. The real parser never
// loads this file. Mode is argv[2]; some modes take a number in argv[3].
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const mode = process.argv[2];
const arg = process.argv[3];

/** The error code of an attempt, or "ALLOWED" if it succeeded. */
async function attempt(fn) {
  try {
    await fn();
    return "ALLOWED";
  } catch (e) {
    return e && e.code ? String(e.code) : String(e && e.name);
  }
}

function say(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`, () => process.exit(0));
}

if (mode === "deny") {
  // arg: a file that exists OUTSIDE the folders this child may read
  const [{ spawnSync }, { Worker }] = await Promise.all([
    import("node:child_process"),
    import("node:worker_threads"),
  ]);
  const result = {
    readOutside: await attempt(() => fs.readFileSync(arg)),
    readDirOutside: await attempt(() => fs.readdirSync(path.dirname(arg))),
    writeFile: await attempt(() =>
      fs.writeFileSync(path.join(process.cwd(), "sandbox-write-test.txt"), "x"),
    ),
    mkdir: await attempt(() => fs.mkdirSync(path.join(process.cwd(), "sandbox-dir-test"))),
    childProcess: await attempt(() => spawnSync(process.execPath, ["-e", "0"])),
    worker: await attempt(() => new Worker("0", { eval: true })),
    envVariables: Object.keys(process.env).length,
    envNames: Object.keys(process.env),
    // Not restricted by Node 24's permission model; reported so nobody assumes it is.
    network: await attempt(
      () =>
        new Promise((resolve, reject) => {
          const s = net.connect({ host: "127.0.0.1", port: 9 }); // discard port: refusal still shows the call was allowed
          s.on("connect", () => (s.destroy(), resolve(undefined)));
          s.on("error", (e) => (e.code === "ECONNREFUSED" ? resolve(undefined) : reject(e)));
          setTimeout(() => (s.destroy(), resolve(undefined)), 1000);
        }),
    ),
    heapSizeLimitMb: Math.round(
      (await import("node:v8")).getHeapStatistics().heap_size_limit / 1048576,
    ),
  };
  say(result);
} else if (mode === "heap") {
  // Grows the JS heap until V8 gives up (--max-old-space-size).
  const keep = [];
  for (;;) keep.push(new Array(100_000).fill("x"));
} else if (mode === "buffer") {
  // Allocates real (touched) memory outside the heap, in 50 MB steps, up to arg MB.
  const target = Number(arg ?? 1000);
  const keep = [];
  let mb = 0;
  let error = null;
  try {
    while (mb < target) {
      keep.push(Buffer.alloc(50 * 1024 * 1024, 1));
      mb += 50;
    }
  } catch (e) {
    error = e.code ?? e.name;
  }
  say({ allocatedMb: mb, error });
} else if (mode === "spin") {
  for (;;);
} else if (mode === "sleep") {
  setTimeout(() => say({ slept: true }), Number(arg ?? 1000));
} else if (mode === "output") {
  // Writes without end.
  const chunk = Buffer.alloc(1024 * 1024, 0x61);
  const write = () => process.stdout.write(chunk, write);
  write();
} else if (mode === "crash") {
  process.exit(Number(arg ?? 3));
} else if (mode === "garbage") {
  process.stdout.write("this is not json\n", () => process.exit(0));
} else if (mode === "echo") {
  // Returns what it was given on stdin, as a JSON string (tests of the pipe and the cleanup).
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  say({ bytes: Buffer.concat(chunks).length });
} else {
  process.stderr.write("unknown mode\n");
  process.exit(2);
}
