import { csvRow } from "@/lib/csv";
import { crc32, writeStoredZip } from "@/lib/import/xlsx-zip.mjs";

/** Every table a shop's owner gets back, in this order. One CSV file each. */
export const ACCOUNT_TABLES = [
  "locations",
  "registers",
  "memberships",
  "tender_types",
  "categories",
  "products",
  "variants",
  "variant_costs",
  "customers",
  "suppliers",
  "sales",
  "sale_lines",
  "payments",
  "refunds",
  "refund_lines",
  "refund_payments",
  "stock_movements",
  "shifts",
  "shift_closes",
  "cash_movements",
] as const;

const PAGE = 5000;
/** The database refuses a stored file above 150 MB, so stop building before that. */
export const MAX_ZIP_BYTES = 150 * 1024 * 1024;

export class ExportTooLarge extends Error {}

type Page = (table: string, offset: number, limit: number) => Promise<Record<string, unknown>[]>;

/** A JSON value as one CSV cell: objects and arrays as JSON, text made formula-safe by csvRow. */
const cell = (v: unknown): string | number =>
  v === null || v === undefined
    ? ""
    : typeof v === "number"
      ? v
      : typeof v === "string"
        ? v
        : JSON.stringify(v);

/**
 * Builds the account ZIP (stored, one CSV per table, plus README and manifest). Rows arrive a page at
 * a time from `page`; money columns stay integer cents exactly as stored. Throws ExportTooLarge
 * rather than build a file the database would refuse.
 * ponytail: held in memory and stored uncompressed; add deflate or streaming if a shop outgrows 150 MB.
 */
export async function buildAccountZip(
  page: Page,
  { shop, madeAt }: { shop: string; madeAt: string },
  maxBytes = MAX_ZIP_BYTES,
): Promise<Buffer> {
  const parts: { name: Buffer; data: Buffer; crc: number }[] = [];
  const counts: Record<string, number> = {};
  let total = 0;
  const add = (name: string, text: string) => {
    const data = Buffer.from(text, "utf8");
    total += data.length;
    if (total > maxBytes) throw new ExportTooLarge();
    parts.push({ name: Buffer.from(name, "ascii"), data, crc: crc32(data) });
  };

  for (const table of ACCOUNT_TABLES) {
    const lines: string[] = [];
    let columns: string[] | null = null;
    let n = 0;
    for (let offset = 0; ; offset += PAGE) {
      const rows = await page(table, offset, PAGE);
      for (const r of rows) {
        columns ??= Object.keys(r);
        lines.push(csvRow(columns.map((c) => cell(r[c]))));
        n++;
      }
      if (rows.length < PAGE) break;
    }
    counts[table] = n;
    add(
      `${table}.csv`,
      `﻿${csvRow(columns ?? ["(no rows)"])}\r\n${lines.join("\r\n")}${lines.length ? "\r\n" : ""}`,
    );
  }

  add(
    "README.txt",
    [
      `Tillflow data export for ${shop}`,
      `Made ${madeAt}.`,
      "",
      "One CSV file per table. Amounts are whole cents (1230 = 12.30). VAT rates are basis points (2300 = 23%).",
      "Times are UTC. Text is UTF-8. Cells that start with = + - or @ have a leading apostrophe added.",
      "Staff PIN hashes and till device tokens are not included.",
      "Keep this file safe: it holds your customers' details.",
    ].join("\r\n"),
  );
  add("manifest.json", JSON.stringify({ shop, madeAt, rows: counts }, null, 2));
  return writeStoredZip(parts);
}
