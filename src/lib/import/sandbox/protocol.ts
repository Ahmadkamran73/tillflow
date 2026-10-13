import { z } from "zod";
import { MAX_CELL_CHARS, MAX_COLUMNS, MAX_ROWS } from "../limits.mjs";

/**
 * What the sandboxed xlsx parser may say. Everything the child writes is untrusted: a compromised
 * or buggy child could write anything, so the parent accepts ONE JSON document of exactly this shape
 * and nothing else (no extra keys, bounded sizes, every cell a string), then validates the rows again
 * like any other upload before they are used.
 */
const cell = z.string().max(MAX_CELL_CHARS);
const row = z.array(cell).max(MAX_COLUMNS + 1);

const success = z
  .strictObject({ ok: z.literal(true), headers: row, matrix: z.array(row).max(MAX_ROWS) })
  .refine(
    (a) => a.matrix.every((r) => r.length === a.headers.length),
    "rows must be as wide as the header",
  );

const refusal = z.strictObject({
  ok: z.literal(false),
  code: z.enum(["unreadable", "size", "rows", "columns", "empty"]),
});

export const sandboxAnswer = z.union([success, refusal]);
export type SandboxAnswer = z.infer<typeof sandboxAnswer>;

/** The child's stdout as a validated answer, or null if it is anything else. */
export function readAnswer(stdout: Buffer): SandboxAnswer | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout.toString("utf8"));
  } catch {
    return null;
  }
  const checked = sandboxAnswer.safeParse(value);
  return checked.success ? checked.data : null;
}
