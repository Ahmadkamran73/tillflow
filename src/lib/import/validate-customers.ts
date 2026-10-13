import { customerFields, toDbCustomer } from "@/lib/customer-schema";
import { t } from "@/lib/i18n";
import type { MessageKey } from "@/lib/i18n";
import type { Field, Mapping } from "./fields";
import { derivedId, type RowError } from "./validate";

/** One customer for ops.import_apply_customers. `set` lists the fields the file gave a value for. */
export type CustomerItem = {
  ref: string;
  rows: number[];
  id: string;
  key: string | null;
  fields: ReturnType<typeof toDbCustomer>;
  set: ("phone" | "vat_number" | "address" | "notes")[];
};
export type CustomerBuild = { items: CustomerItem[]; errors: RowError[]; readyRows: number };

const PROBLEM: Partial<Record<Field, MessageKey>> = {
  name: "import.err.cName",
  email: "import.err.cEmail",
  phone: "import.err.cPhone",
  vatNumber: "import.err.cVat",
  address: "import.err.cAddress",
  notes: "import.err.cNotes",
};

const DB_NAME = {
  phone: "phone",
  vatNumber: "vat_number",
  address: "address",
  notes: "notes",
} as const;

/**
 * Turns file rows into customers using the SAME rules as the customers screen (customer-schema.ts:
 * name 1-120, e-mail, phone, VAT number, address, notes), so a file can never create what the form
 * would refuse. Marketing consent is not a column and is never set: it needs an explicit tick per
 * customer. Rows with a problem are listed and skipped; an e-mail twice in one file: first row wins.
 */
export function buildCustomerItems(
  importId: string,
  rows: Record<string, string>[],
  mapping: Mapping,
): CustomerBuild {
  const errors: RowError[] = [];
  const items: CustomerItem[] = [];
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

    const email = parsed.success ? parsed.data.email : null;
    if (email) {
      const first = seen.get(email);
      if (first === undefined) seen.set(email, row);
      else fail("email", t("import.err.dupEmail", { row: first }));
    }

    if (!bad && parsed.success) {
      items.push({
        ref: String(row),
        rows: [row],
        id: derivedId(importId, `c:${row}`),
        key: email,
        fields: toDbCustomer(parsed.data),
        set: (Object.keys(DB_NAME) as (keyof typeof DB_NAME)[])
          .filter((f) => cell(f) !== "")
          .map((f) => DB_NAME[f]),
      });
    }
  });
  return { items, errors, readyRows: items.length };
}
