import { csvRow } from "@/lib/csv";
import type { RowError } from "./validate";

/**
 * The file the shop downloads to fix and re-upload: the rows that failed, in their own columns,
 * plus the row number and the reasons. Cells starting with = + - @ are escaped by csvCell.
 */
export function errorsCsv(
  headers: string[],
  rows: Record<string, string>[],
  errors: RowError[],
): string {
  const byRow = new Map<number, string[]>();
  for (const e of errors)
    byRow.set(e.row, [...(byRow.get(e.row) ?? []), `${e.field}: ${e.message}`]);
  const lines = [csvRow(["Row", "Problems", ...headers])];
  for (const [row, problems] of [...byRow].sort((a, b) => a[0] - b[0])) {
    const src = rows[row - 2];
    lines.push(csvRow([row, problems.join(" | "), ...headers.map((h) => src?.[h] ?? "")]));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}
