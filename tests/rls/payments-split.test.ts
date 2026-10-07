// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);

/** A 7.00 sale (2 x 3.50 tea, VAT-inclusive 23%) with the given payments. */
function sale(
  shop: Shop,
  vid: string,
  pid: string,
  payments: unknown[],
  over: Record<string, unknown> = {},
) {
  return {
    sale: {
      id: randomUUID(),
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
      ...over,
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
    payments,
  };
}

const record = async (ctx: Ctx, p: unknown) =>
  (await ctx.sql`select ops.record_sale(${json(ctx, p)}) as r`)[0]!.r as string;
const typeId = async (ctx: Ctx, loc: string, method: string) =>
  (await ctx.sql`select id from tender_types where location_id = ${loc} and method = ${method}`)[0]!
    .id as string;
const payCount = async (ctx: Ctx, org: string) =>
  (await ctx.sql`select count(*)::int as n from payments where org_id = ${org}`)[0]!.n as number;

describe("ops.record_sale with split payments", () => {
  it("stores card + cash with type, label, tip and reference", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const { pid, vid } = await seedProduct(ctx, a.orgId);
      const card = await typeId(ctx, a.locationId, "card");
      const cash = await typeId(ctx, a.locationId, "cash");
      const p = sale(a, vid, pid, [
        {
          type_id: card,
          method: "card",
          amount: 400,
          tendered: 400,
          change: 0,
          tip: 50,
          reference: "AUTH 123456",
        },
        { type_id: cash, method: "cash", amount: 300, tendered: 500, change: 200 },
      ]);
      expect(await record(ctx, p)).toBe("created");
      const rows =
        await ctx.sql`select method, label, amount_cents, tip_cents, change_cents, provider_ref
                                 from payments where org_id = ${a.orgId} order by method`;
      expect(
        rows.map((r) => [
          r.method,
          r.label,
          r.amount_cents,
          r.tip_cents,
          r.change_cents,
          r.provider_ref,
        ]),
      ).toEqual([
        ["card", "Card", 400, 50, 0, "AUTH 123456"],
        ["cash", "Cash", 300, 0, 200, null],
      ]);
    }));

  it("still accepts the old single `payment` shape", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const { pid, vid } = await seedProduct(ctx, a.orgId);
      const { payments: _unused, ...rest } = sale(a, vid, pid, []);
      void _unused;
      const p = { ...rest, payment: { method: "cash", amount: 700, tendered: 1000, change: 300 } };
      expect(await record(ctx, p)).toBe("created");
      expect(await payCount(ctx, a.orgId)).toBe(1);
    }));

  it("refuses payments that do not add up, and writes nothing", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const { pid, vid } = await seedProduct(ctx, a.orgId);
      const bad = sale(a, vid, pid, [{ method: "card", amount: 699, tendered: 699, change: 0 }]);
      await ctx.denied(() => record(ctx, bad), ["22023"]);
      expect(
        (await ctx.sql`select count(*)::int as n from sales where org_id = ${a.orgId}`)[0]!.n,
      ).toBe(0);
    }));

  it("refuses two cash payments, a tendered-less-change mismatch, change on card, tip on cash", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const { pid, vid } = await seedProduct(ctx, a.orgId);
      const cases: [unknown[], string[]][] = [
        [
          [
            { method: "cash", amount: 350, tendered: 350, change: 0 },
            { method: "cash", amount: 350, tendered: 350, change: 0 },
          ],
          ["22023"],
        ],
        [[{ method: "cash", amount: 700, tendered: 800, change: 50 }], ["22023"]],
        [[{ method: "card", amount: 700, tendered: 800, change: 100 }], ["23514"]],
        [[{ method: "cash", amount: 700, tendered: 700, change: 0, tip: 10 }], ["23514"]],
        [[{ method: "card", amount: 700, tendered: 700, change: 0, tip: 701 }], ["23514"]],
        [[], ["22023"]],
      ];
      for (const [pays, codes] of cases)
        await ctx.denied(() => record(ctx, sale(a, vid, pid, pays)), codes);
      expect(await payCount(ctx, a.orgId)).toBe(0);
    }));

  it("refuses anything that looks like a card number in the reference", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const { pid, vid } = await seedProduct(ctx, a.orgId);
      for (const ref of [
        "4111111111111111",
        "4111 1111 1111 1111",
        "4111-1111-1111-1111",
        "4111a1111a1111a1111",
        "AUTH_123", // outside the allowed characters
        "x".repeat(41),
      ]) {
        await ctx.denied(
          () =>
            record(
              ctx,
              sale(a, vid, pid, [
                { method: "card", amount: 700, tendered: 700, change: 0, reference: ref },
              ]),
            ),
          ["23514"],
        );
      }
      const ok = sale(a, vid, pid, [
        { method: "card", amount: 700, tendered: 700, change: 0, reference: "AUTH 123456" },
      ]);
      expect(await record(ctx, ok)).toBe("created");
    }));

  it("refuses a tender type of another shop, another location, or the wrong method", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const { pid, vid } = await seedProduct(ctx, a.orgId);
      const bCard = await typeId(ctx, b.locationId, "card");
      const aCash = await typeId(ctx, a.locationId, "cash");
      const loc2 = randomUUID();
      await ctx.sql`insert into locations (id, org_id, name) values (${loc2}, ${a.orgId}, 'Second')`;
      const otherLoc = await typeId(ctx, loc2, "card");
      for (const id of [bCard, otherLoc, aCash]) {
        await ctx.denied(
          () =>
            record(
              ctx,
              sale(a, vid, pid, [
                { type_id: id, method: "card", amount: 700, tendered: 700, change: 0 },
              ]),
            ),
          ["22023"],
        );
      }
    }));

  it("an archived type still works for a sale queued offline", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const { pid, vid } = await seedProduct(ctx, a.orgId);
      const card = await typeId(ctx, a.locationId, "card");
      await ctx.sql`update tender_types set archived_at = now() where id = ${card}`;
      expect(
        await record(
          ctx,
          sale(a, vid, pid, [
            { type_id: card, method: "card", amount: 700, tendered: 700, change: 0 },
          ]),
        ),
      ).toBe("created");
    }));
});

describe("public.tender_totals", () => {
  it("totals per payment type for managers; cashiers, Shop B and anon are refused", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const { pid, vid } = await seedProduct(ctx, a.orgId);
      const card = await typeId(ctx, a.locationId, "card");
      await record(
        ctx,
        sale(a, vid, pid, [
          { type_id: card, method: "card", amount: 700, tendered: 700, change: 0, tip: 100 },
        ]),
      );
      await record(
        ctx,
        sale(a, vid, pid, [{ method: "cash", amount: 700, tendered: 1000, change: 300 }], {
          receipt_seq: 2,
        }),
      );
      const from = new Date(Date.now() - 3_600_000).toISOString();
      const to = new Date(Date.now() + 3_600_000).toISOString();
      const q = (org: string) => ctx.sql`select * from tender_totals(${org}, ${from}, ${to})`;

      const rows = await ctx.as(a.manager, () => q(a.orgId));
      expect(
        rows.map((r) => [
          r.method,
          Number(r.payments),
          Number(r.amount_cents),
          Number(r.tip_cents),
        ]),
      ).toEqual([
        ["card", 1, 700, 100],
        ["cash", 1, 700, 0],
      ]);
      await ctx.denied(() => ctx.as(a.cashier, () => q(a.orgId)));
      await ctx.denied(() => ctx.as(b.owner, () => q(a.orgId)));
      await ctx.denied(() => ctx.as(null, () => q(a.orgId)));
    }));
});
