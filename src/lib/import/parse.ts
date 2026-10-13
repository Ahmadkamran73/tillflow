import Papa from "papaparse";
import { ImportFileError } from "./errors";
import { MAX_COLUMNS, MAX_FILE_BYTES, MAX_ROWS } from "./limits.mjs";
import { parseXlsxSandboxed } from "./sandbox";

export { ImportFileError, type ImportErrorCode } from "./errors";
export { MAX_COLUMNS, MAX_FILE_BYTES, MAX_ROWS };

export type Parsed = { headers: string[]; rows: Record<string, string>[] };

const ext = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";

/** Unique, trimmed, non-empty header names ("Price", "Price (2)" for a repeat). */
function cleanHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const base = h.trim() || `Column ${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  });
}

function toRows(headers: string[], matrix: string[][]): Parsed {
  if (headers.length === 0 || matrix.length === 0) throw new ImportFileError("empty");
  if (headers.length > MAX_COLUMNS) throw new ImportFileError("columns");
  if (matrix.length > MAX_ROWS) throw new ImportFileError("rows");
  const cols = cleanHeaders(headers);
  return {
    headers: cols,
    rows: matrix.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? "").trim()]))),
  };
}

/**
 * Reads an uploaded product file. Server-side only. CSV (Papa Parse), JSON (an array of objects)
 * and Excel .xlsx (first sheet) are the only formats; anything else is refused, and .sql gets its own
 * message because nothing from a customer is ever run as SQL.
 *
 * An .xlsx is NEVER read in this process. It goes to the isolated parser (src/lib/import/sandbox):
 * a separate Node process with its own memory, time and output limits and no access to files,
 * credentials or the database. That path is off unless IMPORT_XLSX_ENABLED=true and the host has
 * passed the sandbox self-test, and there is deliberately no in-process fallback when it is not.
 */
export async function parseUpload(fileName: string, bytes: Buffer): Promise<Parsed> {
  const kind = ext(fileName);
  if (kind === "sql") throw new ImportFileError("sql");
  if (!["csv", "xlsx", "json"].includes(kind)) throw new ImportFileError("type");
  if (bytes.length > MAX_FILE_BYTES) throw new ImportFileError("size");
  if (bytes.length === 0) throw new ImportFileError("empty");

  if (kind === "xlsx") {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ImportFileError("unreadable"); // zip "PK"
    const { headers, matrix } = await parseXlsxSandboxed(bytes);
    return toRows(headers, matrix);
  }

  if (bytes.includes(0)) throw new ImportFileError("unreadable"); // binary, not text
  const text = bytes.toString("utf8").replace(/^﻿/, "");

  if (kind === "json") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new ImportFileError("unreadable");
    }
    const list = Array.isArray(data)
      ? data
      : data && typeof data === "object" && Array.isArray((data as { products?: unknown }).products)
        ? (data as { products: unknown[] }).products
        : null;
    if (!list) throw new ImportFileError("unreadable");
    if (list.length > MAX_ROWS) throw new ImportFileError("rows");
    const objects = list.filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
    // Stop as soon as the columns exceed the limit, before any row matrix is built.
    const names = new Set<string>();
    for (const o of objects) {
      for (const k of Object.keys(o)) {
        names.add(k);
        if (names.size > MAX_COLUMNS) throw new ImportFileError("columns");
      }
    }
    const headers = [...names];
    return toRows(
      headers,
      objects.map((o) =>
        headers.map((h) => {
          const v = o[h];
          return Array.isArray(v) ? v.join(";") : v === null || v === undefined ? "" : String(v);
        }),
      ),
    );
  }

  const out = Papa.parse<string[]>(text, { skipEmptyLines: "greedy" });
  const [head, ...body] = out.data;
  if (!head) throw new ImportFileError("empty");
  return toRows(head, body);
}
