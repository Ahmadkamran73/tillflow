import { presets, type BusinessType } from "@/config/business-type-presets";

/** Columns an import file can fill. `required` ones must be mapped before the import can start. */
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
] as const;
export type Field = (typeof FIELDS)[number];
export type Mapping = Partial<Record<Field, string | null>>;

export const REQUIRED: Field[] = ["name", "price"];

/** Which fields a business type uses (the rest are ignored, like the product form hides them). */
export function fieldsFor(type: BusinessType): Field[] {
  const p = new Set<string>(presets[type].productFields);
  const out: Field[] = ["name", "price", "category", "taxCategory", "cost", "openingStock", "trackStock"];
  if (p.has("eatInTakeaway")) out.push("takeawayTaxCategory");
  if (p.has("barcode")) out.push("sku", "barcode");
  if (type === "general") out.push("ageRestricted", "deposit");
  if (type === "electronics") out.push("brand", "model", "warrantyMonths", "serialRequired");
  if (type === "clothing") out.push("size", "colour", "season", "styleCode");
  if (type === "cafe" || type === "restaurant") out.push("allergens");
  if (type === "restaurant") out.push("course");
  return out;
}

/** Template column titles shown in the downloadable file. */
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
};

const EXAMPLE: Partial<Record<BusinessType, Partial<Record<Field, string>>>> = {
  general: { name: "Brennans Bread", price: "2.49", category: "Grocery", taxCategory: "0", sku: "BRD-1", barcode: "5390001234567", openingStock: "20" },
  electronics: { name: "Phone case", price: "19.99", category: "Accessories", taxCategory: "23", sku: "CASE-1", brand: "Acme", warrantyMonths: "12", openingStock: "10" },
  clothing: { name: "Cotton tee", price: "24.00", category: "Menswear", taxCategory: "23", size: "M", colour: "Black", styleCode: "TEE-01", openingStock: "5" },
  cafe: { name: "Latte", price: "3.50", category: "Hot drinks", taxCategory: "9", allergens: "milk" },
  restaurant: { name: "Fish and chips", price: "14.50", category: "Mains", taxCategory: "9", allergens: "fish;cereals_gluten", course: "main" },
};

export function templateRows(type: BusinessType): string[][] {
  const fields = fieldsFor(type);
  const ex = EXAMPLE[type] ?? {};
  return [fields.map((f) => TEMPLATE_HEADER[f]), fields.map((f) => ex[f] ?? "")];
}
