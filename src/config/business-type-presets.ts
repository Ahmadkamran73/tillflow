import { z } from "zod";
import { businessTypes } from "@/db/schema/tenancy";

// Business type only switches presets on and off (docs/PLAN.md section 4). Every shop runs the
// same code and can change any setting later; type-specific product data lives in
// `variants.attributes`, validated by `variantAttributes` below.

export type BusinessType = (typeof businessTypes)[number];
export { businessTypes };

export type ProductField =
  | "barcode"
  | "ageRestricted"
  | "deposit"
  | "bagLevy"
  | "serial"
  | "warranty"
  | "brand"
  | "model"
  | "variantMatrix"
  | "season"
  | "styleCode"
  | "modifiers"
  | "allergens"
  | "courses"
  | "eatInTakeaway";

export type RegisterOptions = {
  scanFirst: boolean;
  cashRounding5c: boolean;
  ageCheck: boolean;
  serialPrompt: boolean;
  variantPicker: boolean;
  exchangeFlow: boolean;
  quickCounter: boolean;
  orderName: boolean;
  kitchenTickets: boolean;
  tablePlan: boolean;
  sendByCourse: boolean;
  splitBill: boolean;
  serviceCharge: boolean;
  tips: boolean;
  eatInToggle: boolean;
};

export type DashboardTile =
  | "salesToday"
  | "transactions"
  | "vatCollected"
  | "fastestMovers"
  | "lowStock"
  | "salesByBrand"
  | "serialsSold"
  | "salesBySizeColour"
  | "salesByHour"
  | "tips"
  | "covers"
  | "spendPerCover";

export type ReceiptOptions = {
  warrantyEndDate: boolean;
  giftReceipt: boolean;
  allergens: boolean;
  tipLine: boolean;
};

export type Preset = {
  productFields: readonly ProductField[];
  register: RegisterOptions;
  starterCategories: readonly { name: string; colour: string }[];
  dashboardTiles: readonly DashboardTile[];
  receipt: ReceiptOptions;
};

const registerOff: RegisterOptions = {
  scanFirst: false,
  cashRounding5c: false,
  ageCheck: false,
  serialPrompt: false,
  variantPicker: false,
  exchangeFlow: false,
  quickCounter: false,
  orderName: false,
  kitchenTickets: false,
  tablePlan: false,
  sendByCourse: false,
  splitBill: false,
  serviceCharge: false,
  tips: false,
  eatInToggle: false,
};

const receiptOff: ReceiptOptions = {
  warrantyEndDate: false,
  giftReceipt: false,
  allergens: false,
  tipLine: false,
};

const basics = ["salesToday", "transactions", "vatCollected"] as const;

export const presets: Record<BusinessType, Preset> = {
  general: {
    productFields: ["barcode", "ageRestricted", "deposit", "bagLevy"],
    register: { ...registerOff, scanFirst: true, cashRounding5c: true, ageCheck: true },
    starterCategories: [
      { name: "Grocery", colour: "#4F7A3A" },
      { name: "Drinks", colour: "#2F6690" },
      { name: "Household", colour: "#7A5C3A" },
      { name: "Tobacco", colour: "#6B6B6B" },
    ],
    dashboardTiles: [...basics, "fastestMovers", "lowStock"],
    receipt: receiptOff,
  },
  electronics: {
    productFields: ["barcode", "serial", "warranty", "brand", "model"],
    register: { ...registerOff, scanFirst: true, serialPrompt: true },
    starterCategories: [
      { name: "Phones", colour: "#2F6690" },
      { name: "Accessories", colour: "#4F7A3A" },
      { name: "Repairs", colour: "#B5541C" },
    ],
    dashboardTiles: [...basics, "salesByBrand", "serialsSold"],
    receipt: { ...receiptOff, warrantyEndDate: true },
  },
  clothing: {
    productFields: ["barcode", "variantMatrix", "season", "styleCode"],
    register: { ...registerOff, scanFirst: true, variantPicker: true, exchangeFlow: true },
    starterCategories: [
      { name: "Menswear", colour: "#2F6690" },
      { name: "Womenswear", colour: "#8E3B5B" },
      { name: "Kids", colour: "#4F7A3A" },
      { name: "Shoes", colour: "#7A5C3A" },
    ],
    dashboardTiles: [...basics, "salesBySizeColour", "lowStock"],
    receipt: { ...receiptOff, giftReceipt: true },
  },
  cafe: {
    productFields: ["modifiers", "allergens", "eatInTakeaway"],
    register: {
      ...registerOff,
      cashRounding5c: true,
      quickCounter: true,
      orderName: true,
      kitchenTickets: true,
      tips: true,
      eatInToggle: true,
    },
    starterCategories: [
      { name: "Hot drinks", colour: "#7A5C3A" },
      { name: "Cold drinks", colour: "#2F6690" },
      { name: "Food", colour: "#4F7A3A" },
      { name: "Bakery", colour: "#B5541C" },
    ],
    dashboardTiles: [...basics, "salesByHour", "tips"],
    receipt: { ...receiptOff, allergens: true, tipLine: true },
  },
  restaurant: {
    productFields: ["modifiers", "allergens", "courses", "eatInTakeaway"],
    register: {
      ...registerOff,
      kitchenTickets: true,
      tablePlan: true,
      sendByCourse: true,
      splitBill: true,
      serviceCharge: true,
      tips: true,
      eatInToggle: true,
    },
    starterCategories: [
      { name: "Starters", colour: "#4F7A3A" },
      { name: "Mains", colour: "#B5541C" },
      { name: "Desserts", colour: "#8E3B5B" },
      { name: "Bar", colour: "#2F6690" },
    ],
    dashboardTiles: [...basics, "covers", "spendPerCover", "tips"],
    receipt: { ...receiptOff, allergens: true, tipLine: true },
  },
};

/** The 14 allergens that must be declared on non-prepacked food (FSAI, EU 1169/2011 Annex II). */
export const allergens = [
  "celery",
  "cereals_gluten",
  "crustaceans",
  "eggs",
  "fish",
  "lupin",
  "milk",
  "molluscs",
  "mustard",
  "nuts",
  "peanuts",
  "sesame",
  "soya",
  "sulphites",
] as const;

const shortText = z.string().trim().min(1).max(60);
const hospitality = {
  allergens: z.array(z.enum(allergens)).max(allergens.length).default([]),
};

/** Zod schema for `variants.attributes` per business type. Unknown keys are refused. */
export const variantAttributes = {
  general: z.strictObject({
    ageRestricted: z.boolean().default(false),
    depositCents: z.int().min(0).max(10_000).default(0),
  }),
  electronics: z.strictObject({
    // Serial/IMEI is per unit: captured on the sale line, not stored per variant.
    serialRequired: z.boolean().default(false),
    warrantyMonths: z.int().min(0).max(120).default(0),
    brand: shortText.optional(),
    model: shortText.optional(),
  }),
  clothing: z.strictObject({
    size: shortText,
    colour: shortText,
    season: shortText.optional(),
    styleCode: shortText.optional(),
  }),
  cafe: z.strictObject(hospitality),
  restaurant: z.strictObject({
    ...hospitality,
    course: z.enum(["starter", "main", "dessert", "drink"]).optional(),
  }),
} satisfies Record<BusinessType, z.ZodType>;
