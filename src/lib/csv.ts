const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Text a spreadsheet would run as a formula (starts with = + - @, tab or CR) gets a leading
 * apostrophe. Every export (CSV and Excel) passes user-controlled text through this.
 */
export const safeText = (s: string): string => (FORMULA_START.test(s) ? `'${s}` : s);

/**
 * One CSV cell. Text is made formula-safe; quotes are doubled and the cell quoted when needed.
 */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string") s = safeText(s);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: (string | number | null | undefined)[]) =>
  cells.map(csvCell).join(",");
