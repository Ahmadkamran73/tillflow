import { FIELDS, type Field, type Mapping } from "./fields";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Header names (normalised: lower case, letters and digits only) that mean each field. */
const SYNONYMS: Record<Field, string[]> = {
  name: ["name", "productname", "itemname", "title", "description", "product", "customername", "fullname", "contactname", "customer", "company"],
  price: ["priceinclvat", "price", "retailprice", "sellingprice", "variantprice", "saleprice", "unitprice"],
  category: ["category", "categories", "productcategory", "type", "department", "group"],
  taxCategory: ["vatrate", "vat", "taxrate", "tax", "taxcategory", "vatcategory"],
  takeawayTaxCategory: ["takeawayvatrate", "takeawayvat", "takeawaytax"],
  cost: ["cost", "costprice", "supplyprice", "defaultunitcost", "costperitem", "avgcost", "unitcost"],
  openingStock: ["openingstock", "stock", "quantity", "qty", "onhand", "variantinventoryqty", "instock"],
  trackStock: ["trackstockyesno", "trackstock", "trackinventory"],
  sku: ["sku", "stockno", "stocknumber", "variantsku", "itemcode", "code", "handle"],
  barcode: ["barcode", "gtin", "upc", "ean", "variantbarcode"],
  ageRestricted: ["agerestrictedyesno", "agerestricted"],
  deposit: ["deposit", "returndeposit"],
  brand: ["brand", "vendor", "manufacturer"],
  model: ["model"],
  warrantyMonths: ["warrantymonths", "warranty"],
  serialRequired: ["serialrequiredyesno", "serialrequired"],
  size: ["size", "option1value", "variationname"],
  colour: ["colour", "color", "option2value"],
  season: ["season"],
  styleCode: ["stylecode", "style"],
  allergens: ["allergensseparatewith", "allergens", "allergen"],
  course: ["course"],
  quantity: ["quantity", "qty", "counted", "count", "onhand", "newstock", "stock", "stocklevel", "received", "delivered"],
  email: ["email", "emailaddress", "mail", "customeremail"],
  phone: ["phone", "phonenumber", "telephone", "tel", "mobile", "mobilenumber"],
  vatNumber: ["vatnumber", "vatno", "vatid", "vatreg", "taxid", "vatregistration"],
  address: ["address", "streetaddress", "billingaddress", "fulladdress"],
  notes: ["notes", "note", "comments", "comment", "memo", "remarks"],
};

/**
 * Column names in each system's own export. These follow what the vendors document and have not
 * been checked against a live export from each: the mapping screen always shows the result and
 * lets the shop change it.
 */
export const SOURCES = {
  square: {
    label: "Square",
    map: { name: "Item Name", size: "Variation Name", sku: "SKU", barcode: "GTIN", category: "Categories", price: "Price", cost: "Default Unit Cost" },
  },
  lightspeed: {
    label: "Lightspeed",
    map: { name: "name", sku: "sku", barcode: "barcode", category: "product_category", price: "retail_price", cost: "supply_price", brand: "brand" },
  },
  imonggo: {
    label: "Imonggo",
    map: { name: "Name", sku: "Stock No", barcode: "Barcode", category: "Category", price: "Retail Price", cost: "Cost" },
  },
  shopify: {
    label: "Shopify",
    map: { name: "Title", sku: "Variant SKU", barcode: "Variant Barcode", category: "Type", price: "Variant Price", cost: "Cost per item", openingStock: "Variant Inventory Qty", brand: "Vendor", styleCode: "Handle", size: "Option1 Value", colour: "Option2 Value" },
  },
} as const satisfies Record<string, { label: string; map: Mapping }>;
export type SourceId = keyof typeof SOURCES;

/** The preset whose columns appear most often in this file, if at least `name` and `price` do. */
export function detectSource(headers: string[]): SourceId | null {
  const have = new Set(headers.map(norm));
  let best: { id: SourceId; hits: number } | null = null;
  for (const id of Object.keys(SOURCES) as SourceId[]) {
    const map = SOURCES[id].map as Mapping;
    const hits = Object.values(map).filter((h) => h && have.has(norm(h))).length;
    const core = [map.name, map.price].every((h) => h && have.has(norm(h)));
    if (core && hits >= 4 && (!best || hits > best.hits)) best = { id, hits };
  }
  return best?.id ?? null;
}

/**
 * Picks a column for the fields of one import type (`only`; default all): the chosen preset first,
 * then header-name matches. A column is used for at most one field.
 */
export function autoMatch(headers: string[], source?: SourceId | null, only?: readonly Field[]): Mapping {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  const used = new Set<string>();
  const out: Mapping = {};
  const take = (field: Field, header: string | undefined) => {
    if (only && !only.includes(field)) return;
    if (header && !out[field] && !used.has(header)) {
      out[field] = header;
      used.add(header);
    }
  };
  if (source) {
    for (const [f, h] of Object.entries(SOURCES[source].map) as [Field, string][]) {
      take(f, byNorm.get(norm(h)));
    }
  }
  for (const f of FIELDS) for (const s of SYNONYMS[f]) take(f, byNorm.get(s));
  return out;
}
