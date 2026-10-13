// Runs INSIDE the sandboxed child process only (plain Node, started with --permission). The app
// never imports this file: it would pull ExcelJS into the web server process.
import ExcelJS from "exceljs";
import { MAX_CELL_CHARS, MAX_COLUMNS, MAX_ROWS } from "../limits.mjs";
import { canonicalXlsx, XlsxZipError } from "../xlsx-zip.mjs";

/** A refusal the parent can show: the code is one of the import error codes. */
export class XlsxReadError extends Error {
  /** @param {"unreadable" | "size" | "rows" | "columns" | "empty"} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** @param {unknown} v */
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    // A date-styled cell holding an impossible number becomes an Invalid Date: read it as empty.
    if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
    // Formulas are never evaluated: only the value Excel stored is read.
    if ("result" in v) return cellText(v.result);
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if ("text" in v) return String(v.text);
    return "";
  }
  return String(v).trim();
}

/**
 * Reads the first sheet of an uploaded .xlsx: canonical re-zip, ExcelJS on that, then the rows as
 * text. The caller (the child's main) turns an XlsxReadError into a one-line JSON answer.
 * @param {Buffer} bytes
 * @returns {Promise<{ headers: string[], matrix: string[][] }>}
 */
export async function readXlsx(bytes) {
  let canonical;
  try {
    canonical = canonicalXlsx(bytes);
  } catch (e) {
    throw new XlsxReadError(e instanceof XlsxZipError ? e.code : "unreadable");
  }
  const book = new ExcelJS.Workbook();
  try {
    await book.xlsx.load(canonical);
  } catch {
    throw new XlsxReadError("unreadable");
  }
  const sheet = book.worksheets[0];
  if (!sheet) throw new XlsxReadError("empty");
  // Cheap size check first; the real bound on memory is the process limits around this child.
  if (sheet.rowCount - 1 > MAX_ROWS) throw new XlsxReadError("rows");
  try {
    const head = sheet.getRow(1);
    const width = Math.min(head.cellCount, MAX_COLUMNS + 1);
    const text = (cell) => {
      const s = cellText(cell);
      if (s.length > MAX_CELL_CHARS) throw new XlsxReadError("size");
      return s;
    };
    const headers = Array.from({ length: width }, (_, i) => text(head.getCell(i + 1).value));
    /** @type {string[][]} */
    const matrix = [];
    sheet.eachRow((row, n) => {
      if (n === 1) return;
      const cells = headers.map((_, i) => text(row.getCell(i + 1).value));
      if (cells.some((c) => c !== "")) matrix.push(cells);
    });
    return { headers, matrix };
  } catch (e) {
    // ExcelJS can throw while a cell is read (odd numbers, broken styles): a refusal, not a crash.
    throw e instanceof XlsxReadError ? e : new XlsxReadError("unreadable");
  }
}
