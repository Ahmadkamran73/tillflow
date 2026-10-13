// Limits shared by the app (TypeScript) and the sandboxed xlsx child process (plain Node, no bundler).
// Kept in a module with no imports so loading it costs nothing.

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 60;
/** The longest text an Excel cell can hold. Anything longer is not a spreadsheet cell. */
export const MAX_CELL_CHARS = 32_767;

/**
 * What the sandbox enforces on the child process, unless the environment overrides it
 * (src/lib/import/sandbox/index.ts reads IMPORT_SANDBOX_*). The probe reports what a host
 * ACTUALLY enforced, which is what counts: these are intentions until the probe has run there.
 */
export const SANDBOX_DEFAULTS = {
  /** Wall-clock time for one parse. The parent kills the child when it passes. */
  timeoutMs: 20_000,
  /** V8 old-space heap of the child (--max-old-space-size). Heap exhaustion ends only the child. */
  heapMb: 256,
  /** Resident memory of the child, polled from /proc (Linux). Heap flags do not bound Buffers. */
  rssMb: 768,
  /** Bytes the child may write to stdout before the parent kills it. */
  outputBytes: 40 * 1024 * 1024,
  /** Bytes of stderr kept (for diagnostics in tests and the probe, never logged in production). */
  stderrBytes: 8 * 1024,
  /** Address-space cap (ulimit -v, in KB) through `sh`; 0 = not used. Linux only, off by default. */
  ulimitKb: 0,
  /** Parses running at once in one app process, and how many may wait for a slot. */
  concurrency: 2,
  queue: 4,
  queueWaitMs: 10_000,
};
