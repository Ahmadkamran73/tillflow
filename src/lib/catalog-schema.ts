import { z } from "zod";
import {
  allergens,
  presets,
  variantAttributes,
  type BusinessType,
} from "@/config/business-type-presets";
import type { MessageKey } from "@/lib/i18n";
import { t } from "@/lib/i18n";
import { centsToInput, parseCents, TAX_CATEGORIES } from "@/lib/money";

// Shared by the product form (instant feedback) and the server action (the real check).
// The form posts one JSON `payload`; this turns it into the arguments of public.save_product.

export const COURSES = ["starter", "main", "dessert", "drink"] as const;

export type RawVariant = {
  id: string;
  size: string;
  colour: string;
  sku: string;
  barcode: string;
  price: string;
  cost: string;
  openingStock: string;
};

export type RawProduct = {
  productId: string;
  name: string;
  categoryId: string;
  taxCategory: string;
  takeawayTaxCategory: string;
  trackStock: boolean;
  ageRestricted: boolean;
  deposit: string;
  brand: string;
  model: string;
  warrantyMonths: string;
  serialRequired: boolean;
  season: string;
  styleCode: string;
  allergens: string[];
  course: string;
  modifierGroupIds: string[];
  variants: RawVariant[];
};

export type ProductData = {
  product: {
    id: string;
    name: string;
    category_id: string | null;
    tax_category: string;
    takeaway_tax_category: string | null;
    track_stock: boolean;
  };
  variants: {
    id: string;
    name: string;
    sku: string | null;
    barcode: string | null;
    price_incl_vat_cents: number;
    cost_cents: number | null;
    attributes: Record<string, unknown>;
    sort: number;
    opening_stock: number;
  }[];
  modifier_group_ids: string[];
};

export type FieldErrors = Record<string, string[]>;

const rawVariant = z.object({
  id: z.uuid(),
  size: z.string().max(200),
  colour: z.string().max(200),
  sku: z.string().max(200),
  barcode: z.string().max(200),
  price: z.string().max(40),
  cost: z.string().max(40),
  openingStock: z.string().max(40),
});

export const rawProductSchema = z.object({
  productId: z.uuid(),
  name: z.string().max(500),
  categoryId: z.string().max(40),
  taxCategory: z.string().max(40),
  takeawayTaxCategory: z.string().max(40),
  trackStock: z.boolean(),
  ageRestricted: z.boolean(),
  deposit: z.string().max(40),
  brand: z.string().max(200),
  model: z.string().max(200),
  warrantyMonths: z.string().max(40),
  serialRequired: z.boolean(),
  season: z.string().max(200),
  styleCode: z.string().max(200),
  allergens: z.array(z.string().max(40)).max(40),
  course: z.string().max(40),
  modifierGroupIds: z.array(z.string().max(40)).max(40),
  variants: z.array(rawVariant).min(1).max(200),
});

export function emptyVariant(id: string): RawVariant {
  return { id, size: "", colour: "", sku: "", barcode: "", price: "", cost: "", openingStock: "" };
}

export function emptyProduct(type: BusinessType, productId: string, variantId: string): RawProduct {
  return {
    productId,
    name: "",
    categoryId: "",
    // Served food and drink is the common case in a cafe or restaurant.
    taxCategory: type === "cafe" || type === "restaurant" ? "CATERING" : "STANDARD",
    takeawayTaxCategory: "",
    trackStock: type !== "cafe" && type !== "restaurant",
    ageRestricted: false,
    deposit: "",
    brand: "",
    model: "",
    warrantyMonths: "0",
    serialRequired: false,
    season: "",
    styleCode: "",
    allergens: [],
    course: "",
    modifierGroupIds: [],
    variants: type === "clothing" ? [] : [emptyVariant(variantId)],
  };
}

/** Whether the take-away VAT rate applies: cafés and restaurants, or any catering item. */
export function showsTakeaway(type: BusinessType, taxCategory: string) {
  return presets[type].productFields.includes("eatInTakeaway") || taxCategory === "CATERING";
}

const MAX_CENTS = 100_000_000; // same ceiling as the variants_price_range check
const BARCODE = /^[0-9A-Za-z-]{1,32}$/;
const OPTIONAL_TEXT = z.string().trim().max(60);

export function parseProductForm(
  type: BusinessType,
  input: unknown,
  { isNew }: { isNew: boolean },
): { ok: true; data: ProductData } | { ok: false; fieldErrors: FieldErrors } {
  const shape = rawProductSchema.safeParse(input);
  if (!shape.success) return { ok: false, fieldErrors: { form: [t("catalog.errors.fix")] } };
  const raw = shape.data;

  const fields = new Set<string>(presets[type].productFields);
  const errors: FieldErrors = {};
  const fail = (key: string, message: MessageKey) => {
    (errors[key] ??= []).push(t(message));
  };

  const name = raw.name.trim();
  if (name.length < 1 || name.length > 120) fail("name", "catalog.err.name");

  const categoryId = raw.categoryId.trim();
  if (categoryId && !z.uuid().safeParse(categoryId).success)
    fail("categoryId", "catalog.err.category");

  if (!(TAX_CATEGORIES as readonly string[]).includes(raw.taxCategory)) {
    fail("taxCategory", "catalog.err.tax");
  }
  let takeaway: string | null = null;
  if (showsTakeaway(type, raw.taxCategory) && raw.takeawayTaxCategory) {
    if ((TAX_CATEGORIES as readonly string[]).includes(raw.takeawayTaxCategory)) {
      takeaway = raw.takeawayTaxCategory;
    } else {
      fail("takeawayTaxCategory", "catalog.err.takeaway");
    }
  }
  // Served food and drink: hot take-away stays catering (9%) unless the manager picks another rate
  // (cold take-away food is usually 0%).
  if (raw.taxCategory === "CATERING" && !takeaway) takeaway = "CATERING";

  const wantsMatrix = fields.has("variantMatrix");
  if (raw.variants.length < 1 || (!wantsMatrix && raw.variants.length !== 1)) {
    fail("variants", "catalog.err.variants");
  }

  // Attributes shared by every variant of the product.
  const shared: Record<string, unknown> = {};
  const text = (key: string, value: string, name = key) => {
    const v = OPTIONAL_TEXT.safeParse(value);
    if (!v.success) fail(name, "catalog.err.text");
    else if (v.data) shared[key] = v.data;
  };
  if (type === "general") {
    shared.ageRestricted = raw.ageRestricted;
    const deposit = raw.deposit.trim() === "" ? 0 : parseCents(raw.deposit);
    if (deposit === null || deposit > 10_000) fail("deposit", "catalog.err.deposit");
    else shared.depositCents = deposit;
  }
  if (type === "electronics") {
    shared.serialRequired = raw.serialRequired;
    if (/^\d{1,3}$/.test(raw.warrantyMonths.trim()) && Number(raw.warrantyMonths) <= 120) {
      shared.warrantyMonths = Number(raw.warrantyMonths);
    } else fail("warrantyMonths", "catalog.err.warranty");
    text("brand", raw.brand);
    text("model", raw.model);
  }
  if (type === "clothing") {
    text("season", raw.season);
    text("styleCode", raw.styleCode);
  }
  if (type === "cafe" || type === "restaurant") {
    if (raw.allergens.every((a) => (allergens as readonly string[]).includes(a))) {
      shared.allergens = [...new Set(raw.allergens)];
    } else fail("allergens", "catalog.err.allergens");
  }
  if (type === "restaurant" && raw.course) {
    if ((COURSES as readonly string[]).includes(raw.course)) shared.course = raw.course;
    else fail("course", "catalog.err.course");
  }

  const groupIds = fields.has("modifiers") ? [...new Set(raw.modifierGroupIds)] : [];
  if (!groupIds.every((g) => z.uuid().safeParse(g).success) || groupIds.length > 20) {
    fail("modifierGroupIds", "catalog.err.group");
  }

  const seen = {
    barcode: new Map<string, number>(),
    sku: new Map<string, number>(),
    combo: new Map<string, number>(),
  };
  const dup = (map: Map<string, number>, value: string, i: number, field: string) => {
    if (!value) return;
    const first = map.get(value);
    if (first === undefined) map.set(value, i);
    else fail(`variants.${i}.${field}`, "catalog.err.dupInForm");
  };

  const variants: ProductData["variants"] = raw.variants.map((v, i) => {
    const key = (f: string) => `variants.${i}.${f}`;
    const price = parseCents(v.price);
    if (price === null || price > MAX_CENTS) fail(key("price"), "catalog.err.price");
    const cost = v.cost.trim() === "" ? null : parseCents(v.cost);
    if (v.cost.trim() !== "" && (cost === null || cost > MAX_CENTS)) {
      fail(key("cost"), "catalog.err.cost");
    }

    let opening = 0;
    if (isNew && raw.trackStock && v.openingStock.trim() !== "") {
      if (/^\d{1,6}$/.test(v.openingStock.trim())) opening = Number(v.openingStock);
      else fail(key("openingStock"), "catalog.err.stock");
    }

    let barcode: string | null = null;
    let sku: string | null = null;
    if (fields.has("barcode")) {
      barcode = v.barcode.trim() || null;
      sku = v.sku.trim() || null;
      if (barcode && !BARCODE.test(barcode)) fail(key("barcode"), "catalog.err.barcode");
      if (sku && sku.length > 40) fail(key("sku"), "catalog.err.sku");
      dup(seen.barcode, barcode ?? "", i, "barcode");
      dup(seen.sku, sku ?? "", i, "sku");
    }

    const attributes: Record<string, unknown> = { ...shared };
    let variantName = "";
    if (type === "clothing") {
      const size = v.size.trim();
      const colour = v.colour.trim();
      if (!size || size.length > 60) fail(key("size"), "catalog.err.size");
      if (!colour || colour.length > 60) fail(key("colour"), "catalog.err.colour");
      attributes.size = size;
      attributes.colour = colour;
      variantName = `${size} / ${colour}`;
      dup(seen.combo, `${size.toLowerCase()}|${colour.toLowerCase()}`, i, "size");
    }

    // The per-type schema is the last word: unknown keys are refused, defaults are filled in.
    const checked = variantAttributes[type].safeParse(attributes);
    if (!checked.success && Object.keys(errors).length === 0) fail("form", "catalog.errors.fix");

    return {
      id: v.id,
      name: variantName,
      sku,
      barcode,
      price_incl_vat_cents: price ?? 0,
      cost_cents: cost,
      attributes: checked.success ? checked.data : attributes,
      sort: i,
      opening_stock: opening,
    };
  });

  if (Object.keys(errors).length > 0) return { ok: false, fieldErrors: errors };
  return {
    ok: true,
    data: {
      product: {
        id: raw.productId,
        name,
        category_id: categoryId || null,
        tax_category: raw.taxCategory,
        takeaway_tax_category: takeaway,
        track_stock: raw.trackStock,
      },
      variants,
      modifier_group_ids: groupIds,
    },
  };
}

/** Existing product to form values (edit screen). */
export function rawFromProduct(
  type: BusinessType,
  product: {
    id: string;
    name: string;
    categoryId: string | null;
    taxCategory: string;
    takeawayTaxCategory: string | null;
    trackStock: boolean;
    modifierGroupIds: string[];
    variants: {
      id: string;
      sku: string | null;
      barcode: string | null;
      priceInclVatCents: number;
      costCents: number | null;
      attributes: Record<string, unknown>;
    }[];
  },
): RawProduct {
  const base = emptyProduct(type, product.id, product.variants[0]?.id ?? product.id);
  const a = (product.variants[0]?.attributes ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  return {
    ...base,
    name: product.name,
    categoryId: product.categoryId ?? "",
    taxCategory: product.taxCategory,
    takeawayTaxCategory: product.takeawayTaxCategory ?? "",
    trackStock: product.trackStock,
    ageRestricted: a.ageRestricted === true,
    deposit: typeof a.depositCents === "number" ? centsToInput(a.depositCents) : "",
    brand: str("brand"),
    model: str("model"),
    warrantyMonths: typeof a.warrantyMonths === "number" ? String(a.warrantyMonths) : "0",
    serialRequired: a.serialRequired === true,
    season: str("season"),
    styleCode: str("styleCode"),
    allergens: Array.isArray(a.allergens) ? (a.allergens as string[]) : [],
    course: str("course"),
    modifierGroupIds: product.modifierGroupIds,
    variants: product.variants.map((v) => ({
      id: v.id,
      size: typeof v.attributes.size === "string" ? v.attributes.size : "",
      colour: typeof v.attributes.colour === "string" ? v.attributes.colour : "",
      sku: v.sku ?? "",
      barcode: v.barcode ?? "",
      price: centsToInput(v.priceInclVatCents),
      cost: v.costCents === null ? "" : centsToInput(v.costCents),
      openingStock: "",
    })),
  };
}
