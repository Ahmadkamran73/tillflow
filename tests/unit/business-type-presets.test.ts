import { describe, expect, it } from "vitest";
import { businessTypes, presets, variantAttributes } from "@/config/business-type-presets";
import { irishVatNumber, onboardingInput } from "@/lib/onboarding";

describe("business-type presets", () => {
  it("every business type has a preset with unique, valid starter categories", () => {
    expect(Object.keys(presets).sort()).toEqual([...businessTypes].sort());
    for (const type of businessTypes) {
      const names = presets[type].starterCategories.map((c) => c.name);
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
      for (const c of presets[type].starterCategories) expect(c.colour).toMatch(/^#[0-9A-F]{6}$/i);
      expect(presets[type].dashboardTiles).toContain("salesToday");
    }
  });

  it("switches on the register behaviour from PLAN section 4", () => {
    expect(presets.general.register).toMatchObject({ scanFirst: true, ageCheck: true });
    expect(presets.general.register.cashRounding5c).toBe(true);
    expect(presets.electronics.register.serialPrompt).toBe(true);
    expect(presets.electronics.receipt.warrantyEndDate).toBe(true);
    expect(presets.clothing.register).toMatchObject({ variantPicker: true, exchangeFlow: true });
    expect(presets.clothing.receipt.giftReceipt).toBe(true);
    expect(presets.cafe.register).toMatchObject({ quickCounter: true, eatInToggle: true });
    expect(presets.restaurant.register).toMatchObject({
      tablePlan: true,
      splitBill: true,
      serviceCharge: true,
    });
    // Only the type that needs it gets it.
    expect(presets.cafe.register.tablePlan).toBe(false);
    expect(presets.restaurant.register.scanFirst).toBe(false);
  });

  it("product fields match the type", () => {
    expect(presets.electronics.productFields).toEqual(expect.arrayContaining(["imei", "warranty"]));
    expect(presets.clothing.productFields).toContain("variantMatrix");
    expect(presets.cafe.productFields).toContain("allergens");
    expect(presets.general.productFields).toContain("deposit");
  });
});

describe("variant attributes", () => {
  it("accepts valid attributes per type", () => {
    expect(variantAttributes.general.parse({})).toEqual({ ageRestricted: false, depositCents: 0 });
    expect(
      variantAttributes.electronics.parse({ imei: "356938035643809", warrantyMonths: 24 }),
    ).toMatchObject({ warrantyMonths: 24 });
    expect(variantAttributes.clothing.parse({ size: "M", colour: "Navy" })).toBeTruthy();
    expect(variantAttributes.cafe.parse({ allergens: ["milk", "nuts"] }).allergens).toHaveLength(2);
    expect(variantAttributes.restaurant.parse({ course: "main" }).course).toBe("main");
  });

  it("refuses unknown keys, bad IMEIs, missing sizes and unknown allergens", () => {
    expect(variantAttributes.general.safeParse({ imei: "1" }).success).toBe(false);
    expect(variantAttributes.electronics.safeParse({ imei: "12345" }).success).toBe(false);
    expect(variantAttributes.clothing.safeParse({ colour: "Red" }).success).toBe(false);
    expect(variantAttributes.cafe.safeParse({ allergens: ["chocolate"] }).success).toBe(false);
    expect(variantAttributes.general.safeParse({ depositCents: 1.5 }).success).toBe(false);
    expect(variantAttributes.general.safeParse({ depositCents: -15 }).success).toBe(false);
  });
});

describe("Irish VAT number", () => {
  const ok = (v: string) => irishVatNumber.safeParse(v);

  it("accepts valid numbers in any spacing or case and stores them with IE", () => {
    expect(ok("IE1234567T").data).toBe("IE1234567T");
    expect(ok("ie 1234567 t").data).toBe("IE1234567T");
    expect(ok("1234567FA").data).toBe("IE1234567FA"); // two-letter format
    expect(ok("IE8Z49289F").data).toBe("IE8Z49289F"); // old format
  });

  it("refuses a wrong check letter or format", () => {
    for (const v of ["IE1234567A", "IE1234567TA", "IE123456T", "GB123456789", "IE8Z49289G", ""]) {
      expect(ok(v).success, v).toBe(false);
    }
  });

  it("the onboarding form treats a blank VAT number as none", () => {
    const parsed = onboardingInput.parse({
      businessName: "Corner Shop",
      vatNumber: " ",
      businessType: "general",
      tills: "2",
      products: "empty",
    });
    expect(parsed).toMatchObject({ vatNumber: null, tills: 2 });
    expect(onboardingInput.safeParse({ ...parsed, vatNumber: "", tills: "0" }).success).toBe(false);
  });
});
