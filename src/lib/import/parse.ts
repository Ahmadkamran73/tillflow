import { inflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import Papa from "papaparse";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 50_000;
export const MAX_COLUMNS = 60;
const MAX_UNZIPPED_BYTES = 100 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 200;

/**
 * Inflates every part of an .xlsx (a zip) with a hard output cap BEFORE ExcelJS sees it, so a small
 * file that expands to gigabytes is refused instead of exhausting memory. The sizes written in the
 * zip are not trusted: the cap is enforced while inflating.
 */
function assertZipIsSafe(zip: Buffer): void {
  const bad = () => new ImportFileError("unreadable");
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const declared = zip.readUInt16LE(eocd + 10);
  const dirSize = zip.readUInt32LE(eocd + 12);
  const dirStart = zip.readUInt32LE(eocd + 16);
  if (declared > MAX_ZIP_ENTRIES || declared === 0xffff || dirSize === 0xffffffff || dirStart === 0xffffffff) {
    throw bad();
  }
  // JSZip (inside ExcelJS) moves every offset by the bytes found between the directory and this
  // record, and reads headers until the signature stops matching, whatever count is declared. To make
  // sure it sees exactly what is checked here, the directory must end exactly at this record and every
  // header up to it is inspected.
  if (dirStart + dirSize !== eocd) throw bad();
  let total = 0;
  let count = 0;
  let at = dirStart;
  while (at < eocd) {
    if (++count > MAX_ZIP_ENTRIES) throw bad();
    if (at + 46 > eocd || zip.readUInt32LE(at) !== 0x02014b50) throw bad();
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const local = zip.readUInt32LE(at + 42);
    const next = at + 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw bad();
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + compressed);
    if (data.length !== compressed) throw bad();
    try {
      if (method === 0) total += compressed;
      else if (method === 8) total += inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED_BYTES - total + 1 }).length;
      else throw bad();
    } catch (e) {
      if (e instanceof ImportFileError) throw e;
      throw new ImportFileError("size");
    }
    if (total > MAX_UNZIPPED_BYTES) throw new ImportFileError("size");
    at = next;
  }
  if (at !== eocd || count !== declared) throw bad();
}

export type ImportErrorCode = "sql" | "type" | "size" | "rows" | "columns" | "empty" | "unreadable";

/** A refusal with a code the UI turns into a friendly message (src/lib/i18n `import.err.*`). */
export class ImportFileError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}

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

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    // Formulas are never evaluated: only the value Excel stored is read.
    if ("result" in v) return cellText(v.result as ExcelJS.CellValue);
    if ("richText" in v) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
    return "";
  }
  return String(v).trim();
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
 * Reads an uploaded product file. Server-side only. CSV (Papa Parse), Excel .xlsx (ExcelJS, first
 * sheet) and JSON (an array of objects) are the only formats; anything else is refused, and .sql
 * gets its own message because nothing from a customer is ever run as SQL.
 */
export async function parseUpload(fileName: string, bytes: Buffer): Promise<Parsed> {
  const kind = ext(fileName);
  if (kind === "sql") throw new ImportFileError("sql");
  if (!["csv", "xlsx", "json"].includes(kind)) throw new ImportFileError("type");
  if (bytes.length > MAX_FILE_BYTES) throw new ImportFileError("size");
  if (bytes.length === 0) throw new ImportFileError("empty");

  if (kind === "xlsx") {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ImportFileError("unreadable"); // zip "PK"
    assertZipIsSafe(bytes);
    const book = new ExcelJS.Workbook();
    try {
      await book.xlsx.load(bytes as unknown as ArrayBuffer);
    } catch {
      throw new ImportFileError("unreadable");
    }
    const sheet = book.worksheets[0];
    if (!sheet) throw new ImportFileError("empty");
    // Check the size before walking it.
    if (sheet.rowCount - 1 > MAX_ROWS) throw new ImportFileError("rows");
    const head = sheet.getRow(1);
    const width = Math.min(head.cellCount, MAX_COLUMNS + 1);
    const headers = Array.from({ length: width }, (_, i) => cellText(head.getCell(i + 1).value));
    const matrix: string[][] = [];
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      const cells = headers.map((_, i) => cellText(row.getCell(i + 1).value));
      if (cells.some((c) => c !== "")) matrix.push(cells);
    });
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
