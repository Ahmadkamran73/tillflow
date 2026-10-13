import { createHash } from "node:crypto";
import type { BusinessType } from "@/config/business-type-presets";
import {
  emptyProduct,
  emptyVariant,
  parseProductForm,
  type ProductData,
  type RawProduct,
  type RawVariant,
} from "@/lib/catalog-schema";
import { t } from "@/lib/i18n";
import { TAX_CATEGORIES } from "@/lib/money";
import { fieldsFor, type Field, type Mapping } from "./fields";

export type RowError = { row: number; field: string; message: string };

/** One product for ops.import_apply_batch. `rows` are spreadsheet row numbers (header = row 1). */
export type ImportItem = {
  ref: string;
  rows: number[];
  category: string | null;
  /** tax_set / track_set: the file gave a value, so an update may change it (else it is kept). */
  product: ProductData["product"] & { tax_set: boolean; track_set: boolean };
  /** attr_set: the attribute keys the file gave a value for; an update changes only those. */
  variants: (ProductData["variants"][number] & { attr_set: string[] })[];
};

/** Attribute key each file column feeds, for "only change what the file says". */
const ATTRIBUTE_OF: Partial<Record<Field, string>> = {
  ageRestricted: "ageRestricted",
  deposit: "depositCents",
  brand: "brand",
  model: "model",
  warrantyMonths: "warrantyMonths",
  serialRequired: "serialRequired",
  season: "season",
  styleCode: "styleCode",
  allergens: "allergens",
  course: "course",
  size: "size",
  colour: "colour",
};

export type BuildResult = {
  items: ImportItem[];
  errors: RowError[];
  variantCount: number;
  vatDefaulted: number;
};

/** A stable UUID from the import id and a label, so a retried batch meets its own earlier rows. */
export function derivedId(importId: string, label: string): string {
  const h = createHash("sha256").update(`${importId}:${label}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const PERCENT_TO_CATEGORY: Record<string, string> = {
  "23": "STANDARD",
  "13.5": "REDUCED",
  "9": "SECOND_REDUCED",
  "0": "ZERO",
  "4.8": "LIVESTOCK",
};

/** "STANDARD", "23", "23%" or "13,5" to a tax category; "" when blank; null when unknown. */
export function taxCategoryFrom(value: string, type: BusinessType): string | null {
  const v = value.trim();
  if (!v) return "";
  const upper = v.toUpperCase().replace(/[\s-]+/g, "_");
  if ((TAX_CATEGORIES as readonly string[]).includes(upper)) return upper;
  const n = v.replace("%", "").replace(",", ".").trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(n)) return null;
  const key = String(Number(n));
  // 9% in a café or restaurant is served food and drink, which has its own category.
  if (key === "9" && (type === "cafe" || type === "restaurant")) return "CATERING";
  return PERCENT_TO_CATEGORY[key] ?? null;
}

const YES = new Set(["yes", "y", "true", "1", "x"]);
const NO = new Set(["no", "n", "false", "0"]);
/** "yes"/"no"-style cell to a boolean; blank gives `blank`; anything else is null (an error). */
function yesNo(value: string, blank: boolean): boolean | null {
  const v = value.trim().toLowerCase();
  if (!v) return blank;
  if (YES.has(v)) return true;
  if (NO.has(v)) return false;
  return null;
}

const ALLERGEN_ALIASES: Record<string, string> = {
  gluten: "cereals_gluten",
  dairy: "milk",
  "tree nuts": "nuts",
  soy: "soya",
};

/**
 * Turns file rows into products. Every row goes through the same `parseProductForm` as the product
 * form, so import and form can never disagree; rows with a problem are listed and skipped, the rest
 * go on. Clothing rows that share a style code (or name) become one product with several variants.
 */
export function buildItems(
  importId: string,
  type: BusinessType,
  rows: Record<string, string>[],
  mapping: Mapping,
): BuildResult {
  const allowed = new Set<Field>(fieldsFor(type));
  const errors: RowError[] = [];
  let vatDefaulted = 0;

  const prepared: {
    row: number;
    raw: RawProduct;
    category: string | null;
    key: string;
    attrSet: string[];
    taxSet: boolean;
    trackSet: boolean;
  }[] = [];
  const seen = { sku: new Map<string, number>(), barcode: new Map<string, number>() };

  rows.forEach((source, i) => {
    const row = i + 2;
    const get = (f: Field) => {
      const h = mapping[f];
      // hasOwn: a column called "constructor" must not reach Object.prototype.
      return allowed.has(f) && h && Object.hasOwn(source, h) ? (source[h] ?? "").trim() : "";
    };
    const fail = (field: string, message: string) => errors.push({ row, field, message });
    let bad = false;

    const raw = emptyProduct(
      type,
      derivedId(importId, `p:${row}`),
      derivedId(importId, `v:${row}`),
    );
    raw.name = get("name");

    const tax = taxCategoryFrom(get("taxCategory"), type);
    if (tax === null) {
      fail("taxCategory", t("import.err.vat"));
      bad = true;
    } else if (tax === "") vatDefaulted += 1;
    else raw.taxCategory = tax;

    const takeaway = taxCategoryFrom(get("takeawayTaxCategory"), type);
    if (takeaway === null) {
      fail("takeawayTaxCategory", t("import.err.vat"));
      bad = true;
    } else raw.takeawayTaxCategory = takeaway;

    const flag = (f: Field, blank: boolean) => {
      const b = yesNo(get(f), blank);
      if (b === null) {
        fail(f, t("import.err.yesNo"));
        bad = true;
      }
      return b ?? blank;
    };
    raw.trackStock = flag("trackStock", raw.trackStock);
    raw.ageRestricted = flag("ageRestricted", false);
    raw.serialRequired = flag("serialRequired", false);

    raw.deposit = get("deposit");
    raw.brand = get("brand");
    raw.model = get("model");
    raw.warrantyMonths = get("warrantyMonths") || "0";
    raw.season = get("season");
    raw.styleCode = get("styleCode");
    raw.course = get("course").toLowerCase();
    raw.allergens = get("allergens")
      .split(/[;,|]/)
      .map((a) => a.trim().toLowerCase())
      .filter(Boolean)
      .map((a) => ALLERGEN_ALIASES[a] ?? a);

    const variant: RawVariant = {
      ...emptyVariant(derivedId(importId, `v:${row}`)),
      size: get("size"),
      colour: get("colour"),
      sku: get("sku"),
      barcode: get("barcode"),
      price: get("price"),
      cost: get("cost"),
      openingStock: get("openingStock"),
    };
    raw.variants = [variant];

    const category = get("category");
    if (category.length > 60) {
      fail("category", t("import.err.category"));
      bad = true;
    }

    // Each row alone first, so one bad row never hides or takes down another.
    const checked = parseProductForm(type, raw, { isNew: true });
    if (!checked.ok) {
      for (const [key, msgs] of Object.entries(checked.fieldErrors)) {
        fail(key.replace(/^variants\.\d+\./, ""), msgs[0] ?? t("catalog.errors.fix"));
      }
      bad = true;
    }

    // The same SKU or barcode twice in one file: the first row wins, the later one is refused.
    for (const k of ["sku", "barcode"] as const) {
      const val = variant[k].trim();
      if (!val || !allowed.has(k)) continue;
      const first = seen[k].get(val);
      if (first === undefined) seen[k].set(val, row);
      else {
        fail(k, t(k === "sku" ? "import.err.dupSku" : "import.err.dupBarcode", { row: first }));
        bad = true;
      }
    }

    if (!bad) {
      const style = raw.styleCode || raw.name;
      prepared.push({
        row,
        raw,
        category: category || null,
        attrSet: (Object.keys(ATTRIBUTE_OF) as Field[]).filter((f) => get(f) !== "").map((f) => ATTRIBUTE_OF[f]!),
        taxSet: tax !== "" && tax !== null,
        trackSet: get("trackStock") !== "",
        key: type === "clothing" ? `${style.toLowerCase()}|${raw.taxCategory}` : `row:${row}`,
      });
    }
  });

  // Group clothing rows by style; everything else is one product per row.
  const groups = new Map<string, typeof prepared>();
  for (const p of prepared) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);

  const items: ImportItem[] = [];
  let variantCount = 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    let members = group;
    let checked = parseProductForm(
      type,
      { ...first.raw, variants: group.flatMap((g) => g.raw.variants) },
      { isNew: true },
    );
    if (!checked.ok) {
      // A size/colour repeated inside the group: keep the first, refuse the later rows.
      const dup = new Set<number>();
      for (const key of Object.keys(checked.fieldErrors)) {
        const m = key.match(/^variants\.(\d+)\./);
        if (m) dup.add(Number(m[1]));
      }
      for (const idx of dup) {
        errors.push({ row: group[idx]!.row, field: "size", message: t("import.err.dupVariant") });
      }
      members = group.filter((_, idx) => !dup.has(idx));
      if (members.length === 0) continue;
      checked = parseProductForm(
        type,
        { ...first.raw, variants: members.flatMap((g) => g.raw.variants) },
        { isNew: true },
      );
      if (!checked.ok) continue;
    }
    variantCount += members.length;
    items.push({
      ref: String(members[0]!.row),
      rows: members.map((m) => m.row),
      category: first.category,
      product: { ...checked.data.product, tax_set: first.taxSet, track_set: first.trackSet },
      variants: checked.data.variants.map((v, i) => ({ ...v, attr_set: members[i]!.attrSet })),
    });
  }
  errors.sort((a, b) => a.row - b.row);
  return { items, errors, variantCount, vatDefaulted };
}
