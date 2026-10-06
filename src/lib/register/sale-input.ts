import { z } from "zod";
import { depositOf, variantLabel, warrantyOf, type Cart } from "./cart";
import { invoiceInput } from "./invoice";
import { TAX_CATEGORIES, type TaxCategory } from "@/lib/money";

export const discount = z.union([
  z.strictObject({ amount: z.int().min(0).max(100_000_000) }),
  z.strictObject({ percentBp: z.int().min(0).max(10_000) }),
]);

export const saleLine = z.strictObject({
  variantId: z.uuid(),
  qty: z.int().min(1).max(999),
  modifierIds: z.array(z.uuid()).max(30),
  serial: z.string().trim().min(1).max(40).optional(),
  discount: discount.optional(),
});

/** What the register sends to have a receipt emailed: the cart's inputs, never its prices. */
export const emailReceiptInput = z.strictObject({
  lines: z.array(saleLine).min(1).max(100),
  basketDiscount: discount.optional(),
  mode: z.enum(["eat_in", "take_away"]).default("eat_in"),
  /** What the till showed; the email is refused if the server's price differs. */
  expectedDueCents: z.int().min(0).max(100_000_000),
  tenderedCents: z.int().min(0).max(100_000_000),
  receiptSeq: z.int().min(1).max(99_999_999),
  registerName: z.string().trim().min(1).max(80),
  completedAt: z.iso.datetime(),
  to: z.email().max(254),
  invoice: invoiceInput.optional(),
});
export type EmailReceiptInput = z.infer<typeof emailReceiptInput>;

/** Catalogue rows the server loaded (through RLS) for the ids in a sale. */
export type SaleRows = {
  variants: {
    id: string;
    productId: string;
    name: string;
    priceCents: number;
    attributes: Record<string, unknown>;
  }[];
  products: { id: string; name: string; taxCategory: string; takeawayTaxCategory: string | null }[];
  modifiers: { id: string; groupId: string; name: string; priceDeltaCents: number }[];
  productGroups: { productId: string; groupId: string }[];
};

export class SaleError extends Error {}

const isCategory = (c: string): c is TaxCategory =>
  (TAX_CATEGORIES as readonly string[]).includes(c);

/**
 * Rebuilds the cart from the server's catalogue: prices, VAT categories and deposits come from
 * `rows`, only ids, quantities, serials and discounts come from the client. Throws `SaleError`
 * for an unknown variant or a modifier the product does not offer.
 */
export function buildServerCart(
  input: Pick<EmailReceiptInput, "lines" | "basketDiscount"> &
    Partial<Pick<EmailReceiptInput, "mode">>,
  rows: SaleRows,
): Cart {
  const variants = new Map(rows.variants.map((v) => [v.id, v]));
  const products = new Map(rows.products.map((p) => [p.id, p]));
  const modifiers = new Map(rows.modifiers.map((m) => [m.id, m]));
  const offered = new Set(rows.productGroups.map((g) => `${g.productId}:${g.groupId}`));

  return {
    ageChecked: true,
    discount: input.basketDiscount,
    mode: input.mode,
    lines: input.lines.map((l, i) => {
      const v = variants.get(l.variantId);
      const p = v && products.get(v.productId);
      if (!v || !p || !isCategory(p.taxCategory)) throw new SaleError("unknown item");
      if (p.takeawayTaxCategory && !isCategory(p.takeawayTaxCategory))
        throw new SaleError("bad category");
      if (new Set(l.modifierIds).size !== l.modifierIds.length)
        throw new SaleError("duplicate modifier");
      const mods = l.modifierIds.map((id) => {
        const m = modifiers.get(id);
        if (!m || !offered.has(`${p.id}:${m.groupId}`)) throw new SaleError("modifier not offered");
        return { id: m.id, name: m.name, priceDeltaCents: m.priceDeltaCents };
      });
      if (v.priceCents + mods.reduce((s, m) => s + m.priceDeltaCents, 0) < 0)
        throw new SaleError("negative price");
      const label = variantLabel(v);
      return {
        id: String(i),
        variantId: v.id,
        productId: p.id,
        name: label ? `${p.name} – ${label}` : p.name,
        unitPriceCents: v.priceCents,
        modifiers: mods,
        qty: l.qty,
        taxCategory: p.taxCategory,
        takeawayTaxCategory: (p.takeawayTaxCategory as TaxCategory | null) ?? null,
        depositCents: depositOf(v.attributes),
        warrantyMonths: warrantyOf(v.attributes),
        serial: l.serial,
        discount: l.discount,
      };
    }),
  };
}
