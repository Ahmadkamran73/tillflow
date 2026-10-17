import Papa from "papaparse";
import { checkReference, findReferences } from "./reference";

/**
 * Reads a bank statement CSV just far enough to SUGGEST which invoice each payment is for. It
 * never changes anything: a person confirms every match. The file is parsed in memory and not
 * stored; only the matched reference, amount and a short excerpt of the line are shown back.
 * Banks differ, so no column layout is assumed: a line is any row that mentions a payment
 * reference, its amounts are any money-looking cells, its date is the first date-looking cell.
 */
// 1 MB is the server-action body limit; 5,000 statement lines are about 0.5 MB.
export const MAX_STATEMENT_BYTES = 1024 * 1024;
export const MAX_STATEMENT_ROWS = 5000;

export type StatementLine = {
  /** 1-based row number in the file, for finding it again. */
  row: number;
  /** The row's cells joined, cut to 200 characters. */
  text: string;
  /** ISO date (YYYY-MM-DD) of the first date-looking cell, or null. */
  date: string | null;
  amountsCents: number[];
  /** References whose check character is right. */
  references: string[];
  /** Reference-shaped text whose check character is wrong (probably a typo). */
  invalidReferences: string[];
};

export type ParsedStatement = {
  lines: StatementLine[];
  rowsRead: number;
  truncated: boolean;
};

/** `1,234.56`, `1234.56`, `60,27`, `€60.27`, `-12.00` as cents; null if it is not an amount. */
export function parseEuroCents(raw: string): number | null {
  let s = raw.replace(/[€\s]/g, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return null;
  return negative ? -cents : cents;
}

/** `31/10/2026`, `31-10-2026`, `31.10.2026` or `2026-10-31` as an ISO date; null otherwise. */
export function parseStatementDate(raw: string): string | null {
  const s = raw.trim();
  let y: number, m: number, d: number;
  let match = /^(\d{2})[/.-](\d{2})[/.-](\d{4})$/.exec(s);
  if (match)
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  else if ((match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(s)))
    [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function parseStatement(csv: string): ParsedStatement {
  const parsed = Papa.parse<string[]>(csv, { skipEmptyLines: true });
  const rows = parsed.data.filter((r): r is string[] => Array.isArray(r));
  const truncated = rows.length > MAX_STATEMENT_ROWS;
  const lines: StatementLine[] = [];
  rows.slice(0, MAX_STATEMENT_ROWS).forEach((cells, i) => {
    const text = cells.join(" ").replace(/\s+/g, " ").trim();
    const tokens = findReferences(text);
    // Reference-like text that findReferences' shape rule accepted but whose check fails.
    const references = tokens.filter((r) => checkReference(r).ok);
    const invalidReferences = tokens.filter((r) => !checkReference(r).ok);
    if (references.length === 0 && invalidReferences.length === 0) return;
    const amountsCents: number[] = [];
    let date: string | null = null;
    for (const cell of cells) {
      const trimmed = cell.trim();
      date ??= parseStatementDate(trimmed);
      const cents = parseEuroCents(trimmed);
      if (cents !== null && !amountsCents.includes(cents)) amountsCents.push(cents);
    }
    lines.push({
      row: i + 1,
      text: text.slice(0, 200),
      date,
      amountsCents,
      references,
      invalidReferences,
    });
  });
  return { lines, rowsRead: Math.min(rows.length, MAX_STATEMENT_ROWS), truncated };
}

export type InvoiceMatch = {
  reference: string;
  invoice_id: string;
  org_name: string;
  invoice_no: number;
  total_cents: number;
  status: "issued" | "paid" | "void";
  due_on: string;
};

export type Suggestion =
  | { kind: "exact"; line: StatementLine; invoice: InvoiceMatch }
  | { kind: "amountDiffers"; line: StatementLine; invoice: InvoiceMatch }
  | { kind: "paidAlready"; line: StatementLine; invoice: InvoiceMatch }
  | { kind: "unknown"; line: StatementLine; reference: string }
  | { kind: "badCheck"; line: StatementLine; reference: string };

/** Pairs each statement line with the invoices the database found for its references. */
export function suggest(lines: StatementLine[], found: InvoiceMatch[]): Suggestion[] {
  const byRef = new Map(found.map((m) => [m.reference, m]));
  const out: Suggestion[] = [];
  for (const line of lines) {
    for (const ref of line.references) {
      const invoice = byRef.get(ref);
      if (!invoice) out.push({ kind: "unknown", line, reference: ref });
      else if (invoice.status !== "issued") out.push({ kind: "paidAlready", line, invoice });
      else if (line.amountsCents.includes(invoice.total_cents))
        out.push({ kind: "exact", line, invoice });
      else out.push({ kind: "amountDiffers", line, invoice });
    }
    for (const ref of line.invalidReferences) out.push({ kind: "badCheck", line, reference: ref });
  }
  return out;
}
