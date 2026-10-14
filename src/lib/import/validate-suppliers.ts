import { customerFields, toDbCustomer } from "@/lib/customer-schema";
import { t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import type { Field, Mapping } from "./fields";
import { derivedId, type RowError } from "./validate";

/** One supplier for ops.import_apply_suppliers. `set` lists the fields the file gave a value for. */
export type SupplierItem = {
  ref: string;
  rows: number[];
  id: string;
  /** The supplier's name, lower-cased: how an existing supplier is recognised. */
  key: string;
  fields: ReturnType<typeof toDbCustomer>;
  set: ("email" | "phone" | "vat_number" | "address" | "notes")[];
};
export type SupplierBuild = { items: SupplierItem[]; errors: RowError[]; readyRows: number };

const PROBLEM: Partial<Record<Field, MessageKey>> = {
  name: "import.err.cName",
  email: "import.err.cEmail",
  phone: "import.err.cPhone",
  vatNumber: "import.err.cVat",
  address: "import.err.cAddress",
  notes: "import.err.cNotes",
};

const DB_NAME = {
  email: "email",
  phone: "phone",
  vatNumber: "vat_number",
  address: "address",
  notes: "notes",
} as const;

/**
 * Turns file rows into suppliers using the same field rules as customers (name 1-120, e-mail, phone,
 * VAT number, address, notes). A supplier is recognised by its name, ignoring case; the same name
 * twice in one file: first row wins. Rows with a problem are listed and skipped.
 */
export function buildSupplierItems(
  importId: string,
  rows: Record<string, string>[],
  mapping: Mapping,
): SupplierBuild {
  const errors: RowError[] = [];
  const items: SupplierItem[] = [];
  const seen = new Map<string, number>();

  rows.forEach((source, i) => {
    const row = i + 2;
    const cell = (f: Field) => {
      const h = mapping[f];
      return h && Object.hasOwn(source, h) ? (source[h] ?? "").trim() : "";
    };
    let bad = false;
    const fail = (field: string, message: string) => {
      errors.push({ row, field, message });
      bad = true;
    };

    const parsed = customerFields.safeParse({
      name: cell("name"),
      email: cell("email"),
      phone: cell("phone"),
      vatNumber: cell("vatNumber"),
      address: cell("address"),
      notes: cell("notes"),
    });
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? "name") as Field;
        fail(field, t(PROBLEM[field] ?? "import.err.cName"));
      }
    }

    const key = parsed.success ? parsed.data.name.trim().toLowerCase() : "";
    if (key) {
      const first = seen.get(key);
      if (first === undefined) seen.set(key, row);
      else fail("name", t("import.err.dupName", { row: first }));
    }

    if (!bad && parsed.success) {
      items.push({
        ref: String(row),
        rows: [row],
        id: derivedId(importId, `s:${row}`),
        key,
        fields: toDbCustomer(parsed.data),
        set: (Object.keys(DB_NAME) as (keyof typeof DB_NAME)[])
          .filter((f) => cell(f) !== "")
          .map((f) => DB_NAME[f]),
      });
    }
  });
  return { items, errors, readyRows: items.length };
}
