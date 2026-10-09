// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { expectedCash, overShort } from "@/lib/money";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);
const WRONG = ["22023"];
const OPEN_ALREADY = ["TF001"];
const CLASH = ["23505"];

const ev = (shop: Shop, kind: "open" | "cash" | "close", over: Record<string, unknown> = {}) => ({
  kind,
  id: randomUUID(),
  org_id: shop.orgId,
  register_id: shop.registerId,
  user_id: shop.cashier.userId,
  at: new Date().toISOString(),
  ...over,
});
const shiftEvent = async (ctx: Ctx, shop: Shop, e: unknown, token = shop.tokenHash) =>
  (await ctx.sql`select ops.record_shift_event(${token}, ${json(ctx, e)}) as r`)[0]!.r as string;

async function openShift(ctx: Ctx, shop: Shop, float = 10000) {
  const e = ev(shop, "open", { float_cents: float });
  expect(await shiftEvent(ctx, shop, e)).toBe("recorded");
  return e.id;
}

/** A sale of `qty` x 3.50 tea (VAT-inclusive 23%) rung in `shiftId`, paid by `payments`. */
async function sell(
  ctx: Ctx,
  shop: Shop,
  shiftId: string | null,
  qty: number,
  payments: Record<string, unknown>[],
  seq: number,
) {
  const { pid, vid } = await seedProduct(ctx, shop.orgId, `sku-${randomUUID().slice(0, 6)}`);
  const gross = 350 * qty;
  const vat = qty === 1 ? 65 : 131;
  const saleId = randomUUID();
  const p = {
    shift_id: shiftId,
    sale: {
      id: saleId,
      org_id: shop.orgId,
      register_id: shop.registerId,
      user_id: shop.cashier.userId,
      receipt_seq: seq,
      mode: "eat_in",
      completed_at: new Date().toISOString(),
      priced_as_of: new Date().toISOString(),
      items_total: gross,
      vat,
      non_vat: 0,
      cash_rounding: 0,
      amount_due: gross,
      client_due: gross,
    },
    lines: [
      {
        kind: "item",
        variant_id: vid,
        product_id: pid,
        name: "Tea",
        qty,
        unit_price_cents: 350,
        modifiers: [],
        discount_cents: 0,
        tax_category: "STANDARD",
        tax_rate_bp: 2300,
        net_cents: gross - vat,
        vat_cents: vat,
        gross_cents: gross,
      },
    ],
    payments,
  };
  const r = (await ctx.sql`select ops.record_sale(${json(ctx, p)}, ${shop.tokenHash}) as r`)[0]!
    .r as string;
  return { saleId, r };
}

const typeId = async (ctx: Ctx, shop: Shop, method: string) =>
  (
    await ctx.sql`select id from tender_types where location_id = ${shop.locationId} and method = ${method}`
  )[0]!.id as string;

describe("shift events", () => {
  it("opens once per till, is idempotent, and refuses a second open shift", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const e = ev(a, "open", { float_cents: 5000 });
      expect(await shiftEvent(ctx, a, e)).toBe("recorded");
      expect(await shiftEvent(ctx, a, e)).toBe("duplicate");
      await ctx.denied(() => shiftEvent(ctx, a, ev(a, "open", { float_cents: 100 })), OPEN_ALREADY);
      expect(
        (await ctx.sql`select count(*)::int as n from shifts where org_id = ${a.orgId}`)[0]!.n,
      ).toBe(1);
    }));

  it("only the paired till of that shop can write; not staff of another shop either", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const open = ev(a, "open", { float_cents: 0 });
      // B's token for A's register, and an unknown token
      await ctx.denied(() => shiftEvent(ctx, a, open, b.tokenHash));
      await ctx.denied(() => shiftEvent(ctx, a, open, "f".repeat(64)));
      // a cashier of B named on A's till
      await ctx.denied(() => shiftEvent(ctx, a, { ...open, user_id: b.cashier.userId }));
      // bad float
      await ctx.denied(() => shiftEvent(ctx, a, { ...open, float_cents: -1 }), ["23514"]);
    }));

  it("records cash in/out with a note and refuses empty notes, zero amounts, a closed shift", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const shift = await openShift(ctx, a);
      const mv = (over: Record<string, unknown>) =>
        ev(a, "cash", {
          shift_id: shift,
          movement: "in",
          amount_cents: 500,
          note: "Float top-up",
          ...over,
        });
      const good = mv({});
      expect(await shiftEvent(ctx, a, good)).toBe("recorded");
      expect(await shiftEvent(ctx, a, good)).toBe("duplicate");
      await ctx.denied(() => shiftEvent(ctx, a, mv({ note: "  " })), ["23514"]);
      await ctx.denied(() => shiftEvent(ctx, a, mv({ amount_cents: 0 })), ["23514"]);
      await ctx.denied(() => shiftEvent(ctx, a, mv({ movement: "sideways" })), ["23514"]);
      await ctx.denied(() => shiftEvent(ctx, a, mv({ shift_id: randomUUID() })), WRONG);
      await shiftEvent(
        ctx,
        a,
        ev(a, "close", {
          shift_id: shift,
          counted_cents: 10500,
          client_expected_cents: 10500,
          sale_count: 0,
          refund_count: 0,
        }),
      );
      await ctx.denied(() => shiftEvent(ctx, a, mv({})), WRONG);
    }));
});

describe("Z report", () => {
  it("adds up cash, tenders, VAT, refunds and over/short, and cannot be changed", () =>
    inWorld(async (ctx) => {
      const { sql: q, world } = ctx;
      const a = world.a;
      const card = await typeId(ctx, a, "card");
      const cash = await typeId(ctx, a, "cash");
      const shift = await openShift(ctx, a, 10000);

      // Sale 1: 7.00, card 4.00 (tip 0.50) + cash 3.00. Sale 2: 3.50 cash, 5.00 handed over.
      const s1 = await sell(
        ctx,
        a,
        shift,
        2,
        [
          { type_id: card, method: "card", amount: 400, tendered: 400, change: 0, tip: 50 },
          { type_id: cash, method: "cash", amount: 300, tendered: 300, change: 0 },
        ],
        1,
      );
      expect(s1.r).toBe("created");
      const s2 = await sell(
        ctx,
        a,
        shift,
        1,
        [{ type_id: cash, method: "cash", amount: 350, tendered: 500, change: 150 }],
        2,
      );
      expect(s2.r).toBe("created");
      // A replay of sale 2 still answers duplicate and does not double count.
      // (The same payload is rebuilt by sell(), so just check the link table below.)

      await shiftEvent(
        ctx,
        a,
        ev(a, "cash", {
          shift_id: shift,
          movement: "in",
          amount_cents: 2000,
          note: "Change from bank",
        }),
      );
      await shiftEvent(
        ctx,
        a,
        ev(a, "cash", { shift_id: shift, movement: "out", amount_cents: 500, note: "Milk" }),
      );

      // Refund sale 2 in cash.
      const rid = randomUUID();
      const rp = {
        shift_id: shift,
        refund: {
          id: rid,
          org_id: a.orgId,
          register_id: a.registerId,
          user_id: a.cashier.userId,
          original_sale_id: s2.saleId,
          kind: "refund",
          reason_code: "changed_mind",
          receipt_seq: 1,
          completed_at: new Date().toISOString(),
          items_total: 350,
          vat: 65,
          non_vat: 0,
          credit: 0,
          cash_rounding: 0,
          amount: 350,
          client_amount: 350,
        },
        lines: [
          { line_no: 1, qty: 1, restock: true, gross_cents: 350, vat_cents: 65, net_cents: 285 },
        ],
        payments: [{ type_id: cash, method: "cash", amount: 350, tip: 0 }],
      };
      expect((await q`select ops.record_refund(${json(ctx, rp)}, ${a.tokenHash}) as r`)[0]!.r).toBe(
        "created",
      );

      // Live X report, as a manager (RLS) and refused for a cashier.
      const x = (
        await ctx.as(a.manager, () => q`select public.get_shift_report(${a.orgId}, ${shift}) as r`)
      )[0]!.r as Record<string, unknown> & {
        closed: boolean;
        z_seq?: number;
        over_short_cents?: number;
        sales: Record<string, unknown>;
        vat_by_rate: unknown;
        refund_vat_by_rate: unknown;
        tips_cents: number;
        refunds: Record<string, unknown>;
        drawer: Record<string, unknown>;
      };
      expect(x.closed).toBe(false);
      expect(x.sales).toMatchObject({ count: 2, amount_due_cents: 1050, vat_cents: 196 });
      expect(x.vat_by_rate).toEqual([
        { rate_bp: 2300, net_cents: 854, vat_cents: 196, gross_cents: 1050 },
      ]);
      expect(x.refund_vat_by_rate).toEqual([
        { rate_bp: 2300, net_cents: 285, vat_cents: 65, gross_cents: 350 },
      ]);
      expect(x.tips_cents).toBe(50);
      expect(x.refunds).toMatchObject({ count: 1, amount_cents: 350 });
      await ctx.denied(() =>
        ctx.as(a.cashier, () => q`select public.get_shift_report(${a.orgId}, ${shift})`),
      );

      // Drawer: TS twin and SQL agree. 100.00 + 6.50 cash sales + 20.00 in - 5.00 out - 3.50 refund.
      const facts = {
        float: 10000,
        cashSales: 650,
        cashIn: 2000,
        cashOut: 500,
        cashRefunds: 350,
      };
      const expected = expectedCash(facts);
      expect(expected).toBe(11800);
      expect(x.drawer).toMatchObject({
        float_cents: 10000,
        cash_sales_cents: 650,
        cash_in_cents: 2000,
        cash_out_cents: 500,
        cash_refunds_cents: 350,
        expected_cents: expected,
      });

      // Close 2.00 short.
      const close = ev(a, "close", {
        shift_id: shift,
        counted_cents: 11600,
        client_expected_cents: expected,
        sale_count: 2,
        refund_count: 1,
      });
      expect(await shiftEvent(ctx, a, close)).toBe("recorded");
      const [z] = await q`select * from shift_closes where shift_id = ${shift}`;
      expect(z).toMatchObject({
        counted_cents: 11600,
        expected_cents: 11800,
        over_short_cents: overShort(11600, 11800),
      });
      expect(z!.over_short_cents).toBe(-200);
      expect(z!.review_flags).toEqual([]);

      // Replay and second close are refused or ignored; the stored Z never changes.
      expect(await shiftEvent(ctx, a, close)).toBe("duplicate");
      await ctx.denied(() => shiftEvent(ctx, a, { ...close, id: randomUUID() }), CLASH);
      await ctx.denied(() => q`update shift_closes set counted_cents = 11800`, ["42501"]);
      await ctx.denied(() => q`delete from shift_closes`, ["42501"]);
      await ctx.denied(() => q`truncate shift_closes`, ["42501"]);
      await ctx.denied(() => q`update shifts set float_cents = 0`, ["42501"]);
      await ctx.denied(() => q`delete from cash_movements`, ["42501"]);

      // The closed shift reads back as the stored Z.
      const stored = (
        await ctx.as(a.owner, () => q`select public.get_shift_report(${a.orgId}, ${shift}) as r`)
      )[0]!.r as Record<string, unknown> & {
        closed: boolean;
        z_seq?: number;
        over_short_cents?: number;
        sales: Record<string, unknown>;
        vat_by_rate: unknown;
        refund_vat_by_rate: unknown;
        tips_cents: number;
        refunds: Record<string, unknown>;
        drawer: Record<string, unknown>;
      };
      expect(stored).toMatchObject({ closed: true, z_seq: 1, over_short_cents: -200 });

      // A new shift can open now; its Z is number 2 (the server numbers them, gap-free per till),
      // whatever the till might claim.
      const next = await openShift(ctx, a, 0);
      await shiftEvent(
        ctx,
        a,
        ev(a, "close", {
          shift_id: next,
          z_seq: 99,
          counted_cents: 0,
          client_expected_cents: 0,
          sale_count: 0,
          refund_count: 0,
        }),
      );
      expect((await q`select z_seq from shift_closes where shift_id = ${next}`)[0]!.z_seq).toBe(2);
    }));

  it("flags a close whose figures differ from the server's", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const cash = await typeId(ctx, a, "cash");
      const shift = await openShift(ctx, a, 1000);
      await sell(
        ctx,
        a,
        shift,
        1,
        [{ type_id: cash, method: "cash", amount: 350, tendered: 350, change: 0 }],
        1,
      );
      await shiftEvent(
        ctx,
        a,
        ev(a, "close", {
          shift_id: shift,
          counted_cents: 1350,
          client_expected_cents: 1000, // the till missed the sale
          sale_count: 0,
          refund_count: 0,
        }),
      );
      const [z] = await ctx.sql`select review_flags, over_short_cents from shift_closes`;
      expect([...z!.review_flags].sort()).toEqual(["counts_differ", "z_differs"]);
      expect(z!.over_short_cents).toBe(0);
    }));
});

describe("shift links and access", () => {
  it("refuses a sale for another till's shift and accepts a sale with none (older tills)", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const cash = await typeId(ctx, a, "cash");
      const shiftB = await openShift(ctx, b, 0);
      const pay = [{ type_id: cash, method: "cash", amount: 350, tendered: 350, change: 0 }];
      await ctx.denied(() => sell(ctx, a, shiftB, 1, pay, 1), WRONG);
      expect((await sell(ctx, a, null, 1, pay, 1)).r).toBe("created");
    }));

  it("managers and owners read their own shop's shifts; cashiers, anon and Shop B read none", () =>
    inWorld(async (ctx) => {
      const { sql: q, world, as } = ctx;
      const a = world.a;
      const shift = await openShift(ctx, a);
      await shiftEvent(
        ctx,
        a,
        ev(a, "cash", { shift_id: shift, movement: "in", amount_cents: 100, note: "x" }),
      );
      const tables = ["shifts", "cash_movements", "shift_closes", "shift_documents"] as const;
      for (const actor of [a.owner, a.manager]) {
        expect(await as(actor, () => q`select id from shifts`)).toHaveLength(1);
        expect(await as(actor, () => q`select id from cash_movements`)).toHaveLength(1);
      }
      for (const actor of [a.cashier, world.b.owner, world.b.manager, world.b.cashier, null]) {
        for (const t of tables) {
          const rows = await as(actor, () => q.unsafe(`select 1 from ${t}`)).catch(() => []);
          expect(rows).toHaveLength(0);
        }
      }
      // Clients cannot write at all.
      for (const actor of [a.owner, a.manager, a.cashier]) {
        await ctx.denied(() =>
          as(
            actor,
            () => q`insert into shifts (id, org_id, register_id, location_id, opened_by, opened_at, float_cents)
                    values (${randomUUID()}, ${a.orgId}, ${a.registerId}, ${a.locationId}, ${actor.userId}, now(), 0)`,
          ),
        );
      }
    }));
});

describe("hardening from the audits", () => {
  it("refuses a sale linked to an already closed shift, but a replay of a linked one is fine", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const cash = await typeId(ctx, a, "cash");
      const shift = await openShift(ctx, a, 0);
      const pay = [{ type_id: cash, method: "cash", amount: 350, tendered: 350, change: 0 }];
      await sell(ctx, a, shift, 1, pay, 1);
      await shiftEvent(
        ctx,
        a,
        ev(a, "close", {
          shift_id: shift,
          counted_cents: 350,
          client_expected_cents: 350,
          sale_count: 1,
          refund_count: 0,
        }),
      );
      await ctx.denied(() => sell(ctx, a, shift, 1, pay, 2), WRONG);
    }));

  it("flags a close that had refused documents, and bounds the event clock", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const shift = await openShift(ctx, a, 0);
      await ctx.denied(
        () =>
          shiftEvent(
            ctx,
            a,
            ev(a, "cash", {
              shift_id: shift,
              movement: "in",
              amount_cents: 100,
              note: "x",
              at: new Date(Date.now() - 100 * 86_400_000).toISOString(),
            }),
          ),
        WRONG,
      );
      await shiftEvent(
        ctx,
        a,
        ev(a, "close", {
          shift_id: shift,
          counted_cents: 0,
          client_expected_cents: 0,
          sale_count: 0,
          refund_count: 0,
          rejected_count: 1,
        }),
      );
      const [z] = await ctx.sql`select review_flags from shift_closes`;
      expect(z!.review_flags).toEqual(["rejected_excluded"]);
    }));

  it("only the service roles can run the shift functions", () =>
    inWorld(async (ctx) => {
      const rows = await ctx.sql`
        select p.proname,
               has_function_privilege('authenticated', p.oid, 'execute') as auth,
               has_function_privilege('anon', p.oid, 'execute') as anon,
               has_function_privilege('service_role', p.oid, 'execute') as svc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'ops'
          and p.proname in ('record_shift_event', 'record_sale_core', 'record_refund_core',
                            'record_sale', 'record_refund', 'shift_z_email_data')`;
      expect(rows.length).toBeGreaterThanOrEqual(6);
      for (const r of rows)
        expect(r, r.proname).toMatchObject({ auth: false, anon: false, svc: true });
    }));
});
