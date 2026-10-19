import { t } from "@/lib/i18n";
import { fieldLabel, type Mapping } from "./fields";
import type { RowError } from "./validate";

/** One stock line for ops.import_apply_stock. `rows` are spreadsheet row numbers (header = row 1). */
export type StockItem = {
  ref: string;
  rows: number[];
  key: string;
  qty: number;
  note: string | null;
};
export type StockBuild = { items: StockItem[]; errors: RowError[]; readyRows: number };

const WHOLE = /^\d{1,7}$/;
const KEY_MAX = 64;
const NOTE_MAX = 200;

/**
 * Turns file rows into stock lines. `mode` "count": the number is what is on the shelf (the database
 * records the difference from what the system shows); "received": the number is added (a delivery).
 * Rows with a problem are listed and skipped; the rest go on. A SKU or barcode twice in one file: the
 * first row wins. Whether the product exists (and is stock-tracked) is checked against the database.
 */
export function buildStockItems(
  rows: Record<string, string>[],
  mapping: Mapping,
  matchKey: "sku" | "barcode",
  mode: "count" | "received",
): StockBuild {
  const errors: RowError[] = [];
  const items: StockItem[] = [];
  const seen = new Map<string, number>();
  const keyColumn = mapping[matchKey];
  const qtyColumn = mapping.quantity;
  const noteColumn = mapping.notes;

  rows.forEach((source, i) => {
    const row = i + 2;
    const cell = (h: string | null | undefined) =>
      h && Object.hasOwn(source, h) ? (source[h] ?? "").trim() : "";
    let bad = false;
    const fail = (field: string, message: string) => {
      errors.push({ row, field, message });
      bad = true;
    };

    const key = cell(keyColumn);
    if (!key) fail(matchKey, t("import.err.stockKey"));
    else if (key.length > KEY_MAX) fail(matchKey, t("import.err.stockKey"));
    else {
      const first = seen.get(key);
      if (first === undefined) seen.set(key, row);
      else
        fail(
          matchKey,
          t(matchKey === "sku" ? "import.err.dupSku" : "import.err.dupBarcode", { row: first }),
        );
    }

    const raw = cell(qtyColumn);
    let qty = 0;
    if (!WHOLE.test(raw)) fail("quantity", t("import.err.stockQty"));
    else {
      qty = Number(raw);
      if (mode === "received" && qty < 1) fail("quantity", t("import.err.stockQtyZero"));
    }

    const note = cell(noteColumn);
    if (note.length > NOTE_MAX) fail("notes", t("import.err.stockNote"));

    if (!bad) items.push({ ref: String(row), rows: [row], key, qty, note: note || null });
  });
  return { items, errors, readyRows: items.length };
}

/** For messages: the column title as the shop sees it. */
export const stockFieldLabel = (f: "sku" | "barcode" | "quantity" | "notes") =>
  fieldLabel("stock", f);
