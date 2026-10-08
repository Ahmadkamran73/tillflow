// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);

async function makeSale(ctx: Ctx, shop: Shop) {
  const { pid, vid } = await seedProduct(ctx, shop.orgId);
  const id = randomUUID();
  const p = {
    sale: {
      id,
      org_id: shop.orgId,
      register_id: shop.registerId,
      user_id: shop.cashier.userId,
      receipt_seq: 1,
      mode: "eat_in",
      completed_at: new Date().toISOString(),
      priced_as_of: new Date().toISOString(),
      items_total: 700,
      vat: 131,
      non_vat: 0,
      cash_rounding: 0,
      amount_due: 700,
      client_due: 700,
    },
    lines: [
      {
        kind: "item",
        variant_id: vid,
        product_id: pid,
        name: "Tea",
        qty: 2,
        unit_price_cents: 350,
        modifiers: [],
        discount_cents: 0,
        tax_category: "STANDARD",
        tax_rate_bp: 2300,
        net_cents: 569,
        vat_cents: 131,
        gross_cents: 700,
      },
    ],
    payment: { method: "cash", amount: 700, tendered: 700, change: 0 },
  };
  await ctx.sql`select ops.record_sale(${json(ctx, p)})`;
  return id;
}

const note = (ctx: Ctx, shop: Shop, saleId: string, over: Record<string, unknown> = {}) =>
  ctx.sql`select ops.record_sync_note(${json(ctx, {
    kind: "rounding_mode_differs",
    org_id: shop.orgId,
    sale_id: saleId,
    user_id: shop.cashier.userId,
    sale_round_cash: false,
    shop_round_cash: true,
    ...over,
  })})`;

describe("ops.record_sync_note (rounding mode differs)", () => {
  it("writes one audit row for the sale's own shop and leaves the sale untouched", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const saleId = await makeSale(ctx, a);
      const before =
        await ctx.sql`select amount_due_cents, cash_rounding_cents from sales where id = ${saleId}`;
      await note(ctx, a, saleId);
      const rows = await ctx.sql`select actor_user_id, after from audit_log
        where org_id = ${a.orgId} and action = 'sale.rounding_mode_differs' and entity_id = ${saleId}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor_user_id).toBe(a.cashier.userId);
      expect(rows[0]!.after).toEqual({ sale_round_cash: false, shop_round_cash: true });
      const after =
        await ctx.sql`select amount_due_cents, cash_rounding_cents from sales where id = ${saleId}`;
      expect(after).toEqual(before);
    }));

  it("refuses a sale that is not in that shop, an unknown kind and a non-boolean flag", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const saleId = await makeSale(ctx, a);
      // Shop B cannot attach a note to Shop A's sale, nor name Shop A's org for a Shop B sale.
      await ctx.denied(() => note(ctx, b, saleId), ["22023"]);
      await ctx.denied(() => note(ctx, a, randomUUID()), ["22023"]);
      await ctx.denied(() => note(ctx, a, saleId, { kind: "something_else" }), ["22023"]);
      // The actor must be staff of the shop: Shop B's cashier cannot be named on Shop A's sale.
      await ctx.denied(() => note(ctx, a, saleId, { user_id: b.cashier.userId }), ["42501"]);
      await ctx.denied(() => note(ctx, a, saleId, { user_id: randomUUID() }), ["42501"]);
      await ctx.denied(() => note(ctx, a, saleId, { sale_round_cash: "maybe" }), ["22P02"]);
      expect(
        (
          await ctx.sql`select count(*)::int as n from audit_log where action = 'sale.rounding_mode_differs'`
        )[0]!.n,
      ).toBe(0);
    }));

  it("is not callable by signed-in users or anon (only the server's ops role)", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const saleId = await makeSale(ctx, a);
      await ctx.denied(() => ctx.as(a.owner, () => note(ctx, a, saleId)));
      await ctx.denied(() => ctx.as(a.manager, () => note(ctx, a, saleId)));
      await ctx.denied(() => ctx.as(null, () => note(ctx, a, saleId)));
    }));
});
