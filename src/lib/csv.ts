/**
 * One CSV cell. Text that a spreadsheet would run as a formula (starts with = + - @, tab or CR)
 * gets a leading apostrophe; quotes are doubled and the cell quoted when needed.
 */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvRow = (cells: (string | number | null | undefined)[]) =>
  cells.map(csvCell).join(",");
