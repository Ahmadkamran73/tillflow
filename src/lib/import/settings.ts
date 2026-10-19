import type { MessageKey } from "@/lib/i18n";
import {
  MATCH_KEYS,
  MODES,
  requiredFor,
  type Field,
  type ImportType,
  type Mapping,
} from "./fields";

/** What the shop chose on the mapping and check screens. */
export type ImportSettings = {
  mapping: Mapping;
  mode: "create" | "upsert" | "count" | "received";
  matchKey: "sku" | "barcode" | "email" | "name";
};

/** What each kind of import starts with. */
export const DEFAULTS: Record<ImportType, Pick<ImportSettings, "mode" | "matchKey">> = {
  products: { mode: "create", matchKey: "sku" },
  stock: { mode: "count", matchKey: "sku" },
  customers: { mode: "create", matchKey: "email" },
  suppliers: { mode: "create", matchKey: "name" },
};

/**
 * What is wrong with these settings for this kind of import, as a message key, or null. Used by the
 * screens (instant feedback) and again by the routes; the database checks mode and match key a third
 * time (public.confirm_import).
 */
export function settingsProblem(type: ImportType, s: ImportSettings): MessageKey | null {
  if (!MODES[type].includes(s.mode) || !MATCH_KEYS[type].includes(s.matchKey))
    return "import.err.generic";
  const mapped = (f: Field) => Boolean(s.mapping[f]);
  if (type === "products") return requiredFor(type).every(mapped) ? null : "import.err.required";
  if (type === "stock") {
    return mapped("quantity") && mapped(s.matchKey as "sku" | "barcode")
      ? null
      : "import.err.requiredStock";
  }
  if (!mapped("name"))
    return type === "suppliers" ? "import.err.requiredSuppliers" : "import.err.requiredCustomers";
  if (type === "suppliers") return null;
  if (s.mode === "upsert" && !mapped("email")) return "import.err.requiredEmail";
  return null;
}

/** The columns still to be matched before the import can be checked (for marking them on screen). */
export function missingFields(type: ImportType, s: ImportSettings): Field[] {
  const need = new Set<Field>(requiredFor(type));
  if (type === "stock") need.add(s.matchKey as "sku" | "barcode");
  if (type === "customers" && s.mode === "upsert") need.add("email");
  return [...need].filter((f) => !s.mapping[f]);
}
