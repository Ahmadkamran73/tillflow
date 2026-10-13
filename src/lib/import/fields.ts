import { presets, type BusinessType } from "@/config/business-type-presets";

/** What an import file holds. The pipeline (upload, mapping, preview, job, undo) is shared. */
export const IMPORT_TYPES = ["products", "stock", "customers"] as const;
export type ImportType = (typeof IMPORT_TYPES)[number];

/** Columns an import file can fill, across all import types. */
export const FIELDS = [
  "name",
  "price",
  "category",
  "taxCategory",
  "takeawayTaxCategory",
  "cost",
  "openingStock",
  "trackStock",
  "sku",
  "barcode",
  "ageRestricted",
  "deposit",
  "brand",
  "model",
  "warrantyMonths",
  "serialRequired",
  "size",
  "colour",
  "season",
  "styleCode",
  "allergens",
  "course",
  // stock imports
  "quantity",
  // customer imports (name is shared with products)
  "email",
  "phone",
  "vatNumber",
  "address",
  "notes",
] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, string | null>>;

/** Product imports: columns that must be mapped before the import can start. */
export const REQUIRED: Field[] = ["name", "price"];

/** Columns that must be mapped, per import type (stock also needs the SKU or barcode column, see matchKeys). */
export function requiredFor(type: ImportType): Field[] {
  if (type === "stock") return ["quantity"];
  if (type === "customers") return ["name"];
  return REQUIRED;
}

/** Which column identifies the row to change, and what the shop may choose between. */
export const MATCH_KEYS: Record<ImportType, readonly ("sku" | "barcode" | "email")[]> = {
  products: ["sku", "barcode"],
  stock: ["sku", "barcode"],
  customers: ["email"],
};

/** What to do with rows that match something that exists. */
export const MODES: Record<ImportType, readonly ("create" | "upsert" | "count" | "received")[]> = {
  products: ["create", "upsert"],
  stock: ["count", "received"],
  customers: ["create", "upsert"],
};

/** Which fields a business type uses for PRODUCTS (the rest are ignored, like the product form hides them). */
export function fieldsFor(type: BusinessType): Field[] {
  const p = new Set<string>(presets[type].productFields);
  const out: Field[] = [
    "name",
    "price",
    "category",
    "taxCategory",
    "cost",
    "openingStock",
    "trackStock",
  ];
  if (p.has("eatInTakeaway")) out.push("takeawayTaxCategory");
  if (p.has("barcode")) out.push("sku", "barcode");
  if (type === "general") out.push("ageRestricted", "deposit");
  if (type === "electronics") out.push("brand", "model", "warrantyMonths", "serialRequired");
  if (type === "clothing") out.push("size", "colour", "season", "styleCode");
  if (type === "cafe" || type === "restaurant") out.push("allergens");
  if (type === "restaurant") out.push("course");
  return out;
}

/** The columns an import of this type can fill, in the order the mapping screen and templates show them. */
export function importFieldsFor(type: ImportType, business: BusinessType): Field[] {
  if (type === "stock") return ["sku", "barcode", "quantity", "notes"];
  if (type === "customers") return ["name", "email", "phone", "vatNumber", "address", "notes"];
  return fieldsFor(business);
}

/** Template column titles shown in the downloadable file and on the mapping screen. */
export const TEMPLATE_HEADER: Record<Field, string> = {
  name: "Name",
  price: "Price (incl. VAT)",
  category: "Category",
  taxCategory: "VAT rate",
  takeawayTaxCategory: "Take-away VAT rate",
  cost: "Cost",
  openingStock: "Opening stock",
  trackStock: "Track stock (yes/no)",
  sku: "SKU",
  barcode: "Barcode",
  ageRestricted: "Age restricted (yes/no)",
  deposit: "Deposit",
  brand: "Brand",
  model: "Model",
  warrantyMonths: "Warranty months",
  serialRequired: "Serial required (yes/no)",
  size: "Size",
  colour: "Colour",
  season: "Season",
  styleCode: "Style code",
  allergens: "Allergens (separate with ;)",
  course: "Course",
  quantity: "Quantity",
  email: "Email",
  phone: "Phone",
  vatNumber: "VAT number",
  address: "Address",
  notes: "Notes",
};

/** Where one import type names a column differently. */
export function fieldLabel(type: ImportType, field: Field): string {
  if (type === "stock" && field === "notes") return "Note (optional)";
  if (type === "stock" && field === "quantity") return "Quantity";
  return TEMPLATE_HEADER[field];
}

const EXAMPLE: Partial<Record<BusinessType, Partial<Record<Field, string>>>> = {
  general: {
    name: "Brennans Bread",
    price: "2.49",
    category: "Grocery",
    taxCategory: "0",
    sku: "BRD-1",
    barcode: "5390001234567",
    openingStock: "20",
  },
  electronics: {
    name: "Phone case",
    price: "19.99",
    category: "Accessories",
    taxCategory: "23",
    sku: "CASE-1",
    brand: "Acme",
    warrantyMonths: "12",
    openingStock: "10",
  },
  clothing: {
    name: "Cotton tee",
    price: "24.00",
    category: "Menswear",
    taxCategory: "23",
    size: "M",
    colour: "Black",
    styleCode: "TEE-01",
    openingStock: "5",
  },
  cafe: {
    name: "Latte",
    price: "3.50",
    category: "Hot drinks",
    taxCategory: "9",
    allergens: "milk",
  },
  restaurant: {
    name: "Fish and chips",
    price: "14.50",
    category: "Mains",
    taxCategory: "9",
    allergens: "fish;cereals_gluten",
    course: "main",
  },
};

const EXAMPLE_OTHER: Record<"stock" | "customers", Partial<Record<Field, string>>> = {
  stock: { sku: "BRD-1", barcode: "", quantity: "24", notes: "Friday delivery" },
  customers: {
    name: "Mary Byrne",
    email: "mary@example.com",
    phone: "087 123 4567",
    vatNumber: "",
    address: "1 Main St, Cork",
    notes: "Prefers email",
  },
};

export function templateRows(type: BusinessType, importType: ImportType = "products"): string[][] {
  const fields = importFieldsFor(importType, type);
  const ex = importType === "products" ? (EXAMPLE[type] ?? {}) : EXAMPLE_OTHER[importType];
  return [fields.map((f) => fieldLabel(importType, f)), fields.map((f) => ex[f] ?? "")];
}
