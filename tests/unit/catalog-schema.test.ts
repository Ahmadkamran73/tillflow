import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { v7 as uuidv7 } from "uuid";
import { allergens, businessTypes, type BusinessType } from "@/config/business-type-presets";
import {
  emptyProduct,
  emptyVariant,
  parseProductForm,
  rawFromProduct,
  type RawProduct,
} from "@/lib/catalog-schema";
import { TAX_CATEGORIES } from "@/lib/money";

function form(type: BusinessType, patch: Partial<RawProduct> = {}): RawProduct {
  const base = emptyProduct(type, uuidv7(), uuidv7());
  const variants =
    type === "clothing"
      ? [
          { ...emptyVariant(uuidv7()), size: "M", colour: "Black", price: "30" },
          { ...emptyVariant(uuidv7()), size: "L", colour: "Black", price: "30" },
        ]
      : [{ ...base.variants[0]!, price: "12.30" }];
  return { ...base, name: "Thing", taxCategory: "STANDARD", variants, ...patch };
}

const run = (type: BusinessType, patch?: Partial<RawProduct>, isNew = true) =>
  parseProductForm(type, form(type, patch), { isNew });

describe("parseProductForm", () => {
  it("keeps the DB check in step with the money library categories", () => {
    const sql = readFileSync("src/db/schema/products.ts", "utf8");
    for (const c of TAX_CATEGORIES) expect(sql).toContain(`'${c}'`);
  });

  it("accepts a valid product for every business type", () => {
    for (const type of businessTypes) {
      const r = run(type, type === "cafe" || type === "restaurant" ? { allergens: ["milk"] } : {});
      expect(r.ok, type).toBe(true);
    }
  });

  it("turns a price string into integer cents and fills attribute defaults", () => {
    const r = run("general", { ageRestricted: true, deposit: "0.15" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.variants[0]).toMatchObject({
      price_incl_vat_cents: 1230,
      attributes: { ageRestricted: true, depositCents: 15 },
    });
  });

  it("rejects bad names, prices, costs and barcodes with field keys", () => {
    const base = form("general");
    const bad = {
      ...base,
      name: "  ",
      variants: [{ ...base.variants[0]!, price: "12,30", cost: "x", barcode: "no spaces" }],
    };
    const r = parseProductForm("general", bad, { isNew: true });
    if (r.ok) throw new Error("expected errors");
    expect(Object.keys(r.fieldErrors).sort()).toEqual([
      "name",
      "variants.0.barcode",
      "variants.0.cost",
      "variants.0.price",
    ]);
  });

  it("builds clothing variants from size and colour and refuses duplicates", () => {
    const r = run("clothing");
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.variants.map((v) => v.name)).toEqual(["M / Black", "L / Black"]);
    expect(r.data.variants[0]!.attributes).toMatchObject({ size: "M", colour: "Black" });

    const dup = form("clothing");
    dup.variants[1] = { ...dup.variants[1]!, size: "m", colour: "black" };
    expect(parseProductForm("clothing", dup, { isNew: true }).ok).toBe(false);
    expect(run("clothing", { variants: [] }).ok).toBe(false);
  });

  it("refuses two variants with the same barcode in one form", () => {
    const f = form("clothing");
    f.variants[0]!.barcode = "111";
    f.variants[1]!.barcode = "111";
    const r = parseProductForm("clothing", f, { isNew: true });
    if (r.ok) throw new Error("expected errors");
    expect(r.fieldErrors["variants.1.barcode"]).toBeDefined();
  });

  it("only lets a matrix type have several variants", () => {
    const f = form("general");
    f.variants.push({ ...emptyVariant(uuidv7()), price: "1" });
    expect(parseProductForm("general", f, { isNew: true }).ok).toBe(false);
  });

  it("defaults catering take-away to catering, honours a chosen rate, ignores it for plain retail", () => {
    const hot = run("cafe", { taxCategory: "CATERING" });
    if (!hot.ok) throw new Error("expected ok");
    expect(hot.data.product.takeaway_tax_category).toBe("CATERING");
    const ok = run("cafe", { taxCategory: "CATERING", takeawayTaxCategory: "ZERO" });
    if (!ok.ok) throw new Error("expected ok");
    expect(ok.data.product.takeaway_tax_category).toBe("ZERO");
    const retail = run("general", { takeawayTaxCategory: "ZERO" });
    if (!retail.ok) throw new Error("expected ok");
    expect(retail.data.product.takeaway_tax_category).toBeNull();
    expect(run("general", { taxCategory: "CATERING" }).ok).toBe(true);
    expect(run("general", { taxCategory: "MADE_UP" }).ok).toBe(false);
  });

  it("validates allergens against the 14, and ignores fields the type does not use", () => {
    expect(run("cafe", { allergens: ["chocolate"] }).ok).toBe(false);
    const all = run("restaurant", { allergens: [...allergens], course: "main" });
    if (!all.ok) throw new Error("expected ok");
    expect(all.data.variants[0]!.attributes).toMatchObject({ course: "main" });
    // A general shop cannot smuggle allergens or a course in: they are never copied over.
    const g = run("general", { allergens: ["milk"], course: "main", modifierGroupIds: [uuidv7()] });
    if (!g.ok) throw new Error("expected ok");
    expect(g.data.variants[0]!.attributes).not.toHaveProperty("allergens");
    expect(g.data.modifier_group_ids).toEqual([]);
    expect(run("restaurant", { course: "brunch" }).ok).toBe(false);
  });

  it("validates electronics warranty and brand", () => {
    expect(run("electronics", { warrantyMonths: "24", brand: "Acme" }).ok).toBe(true);
    expect(run("electronics", { warrantyMonths: "121" }).ok).toBe(false);
    expect(run("electronics", { brand: "x".repeat(61) }).ok).toBe(false);
  });

  it("opening stock only counts for a new, tracked product", () => {
    const f = form("general");
    f.variants[0]!.openingStock = "7";
    const created = parseProductForm("general", f, { isNew: true });
    const edited = parseProductForm("general", f, { isNew: false });
    const untracked = parseProductForm("general", { ...f, trackStock: false }, { isNew: true });
    if (!created.ok || !edited.ok || !untracked.ok) throw new Error("expected ok");
    expect(created.data.variants[0]!.opening_stock).toBe(7);
    expect(edited.data.variants[0]!.opening_stock).toBe(0);
    expect(untracked.data.variants[0]!.opening_stock).toBe(0);
    f.variants[0]!.openingStock = "-3";
    expect(parseProductForm("general", f, { isNew: true }).ok).toBe(false);
  });

  it("caps price and cost at the database ceiling, and defaults hospitality to catering", () => {
    const f = form("general");
    f.variants[0]!.price = "1000000.01";
    expect(parseProductForm("general", f, { isNew: true }).ok).toBe(false);
    f.variants[0]!.price = "1000000";
    f.variants[0]!.cost = "1000000.01";
    expect(parseProductForm("general", f, { isNew: true }).ok).toBe(false);
    expect(emptyProduct("cafe", uuidv7(), uuidv7()).taxCategory).toBe("CATERING");
    expect(emptyProduct("general", uuidv7(), uuidv7()).taxCategory).toBe("STANDARD");
  });

  it("refuses a payload with the wrong shape", () => {
    expect(parseProductForm("general", { nope: 1 }, { isNew: true }).ok).toBe(false);
    expect(parseProductForm("general", null, { isNew: true }).ok).toBe(false);
  });

  it("round-trips an existing product through the form", () => {
    const raw = rawFromProduct("general", {
      id: uuidv7(),
      name: "Milk",
      categoryId: null,
      taxCategory: "ZERO",
      takeawayTaxCategory: null,
      trackStock: true,
      modifierGroupIds: [],
      variants: [
        {
          id: uuidv7(),
          sku: "MILK1",
          barcode: "5012345678900",
          priceInclVatCents: 189,
          costCents: null,
          attributes: { ageRestricted: false, depositCents: 15 },
        },
      ],
    });
    expect(raw.variants[0]).toMatchObject({ price: "1.89", barcode: "5012345678900", cost: "" });
    expect(raw.deposit).toBe("0.15");
    const r = parseProductForm("general", raw, { isNew: false });
    if (!r.ok) throw new Error("expected ok");
    expect(r.data.variants[0]!.price_incl_vat_cents).toBe(189);
  });
});
