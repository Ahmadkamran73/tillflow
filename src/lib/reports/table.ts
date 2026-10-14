import type { MessageKey } from "@/lib/i18n";
import { centsToInput, formatCents } from "@/lib/money";

/** How a column is shown and exported. `money` cells hold integer cents. */
export type ColumnKind = "text" | "int" | "money";
export type Column = { label: MessageKey; kind: ColumnKind };
export type Cell = string | number;

/** A report as plain rows: the one shape the screen, CSV, Excel and PDF all print. */
export type ReportTable = {
  title: MessageKey;
  columns: Column[];
  rows: Cell[][];
  /** Sums of the int and money columns (null when the report has nothing to add up). */
  totals: Cell[] | null;
};

const int = new Intl.NumberFormat("en-IE");

export function showCell(kind: ColumnKind, v: Cell): string {
  if (typeof v === "string") return v;
  return kind === "money" ? formatCents(v) : int.format(v);
}

/** Plain value for CSV: money as 12.30, counts as digits. Formula escaping happens at write time. */
export function plainCell(kind: ColumnKind, v: Cell): string {
  if (typeof v === "string") return v;
  return kind === "money" ? centsToInput(v) : String(v);
}

/** Add up the int and money columns; the first column carries the word "Total". */
export function withTotals(
  title: MessageKey,
  columns: Column[],
  rows: Cell[][],
  totalLabel: string,
  skip: number[] = [],
): ReportTable {
  if (rows.length === 0) return { title, columns, rows, totals: null };
  const totals = columns.map((c, i): Cell => {
    if (i === 0) return totalLabel;
    if (c.kind === "text" || skip.includes(i)) return "";
    return rows.reduce((s, r) => s + (r[i] as number), 0);
  });
  return { title, columns, rows, totals };
}
