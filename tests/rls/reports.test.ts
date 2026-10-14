// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);
const DAY = 86_400_000;

/** Shop-local date (Europe/Dublin, the seeded timezone) of an instant, as the database sees it. */
async function localDay(ctx: Ctx, at: Date) {
  return (
    await ctx.sql`select (${at.toISOString()}::timestamptz at time zone 'Europe/Dublin')::date::text as d`
  )[0]!.d as string;
}

type SaleOpts = {
  seq: number;
  at?: Date;
  qty?: number;
  serial?: string;
  shiftId?: string;
  name?: string;
  /** Set to give the product a category before the sale. */
  category?: string;
};

/** A sale of `qty` x 3.50 (VAT-inclusive 23%): all card, tip 50c when two units. */
async function sell(ctx: Ctx, shop: Shop, o: SaleOpts) {
  const qty = o.qty ?? 2;
  const { pid, vid } = await seedProduct(ctx, shop.orgId, `sku-${randomUUID().slice(0, 6)}`);
  if (o.name) await ctx.sql`update products set name = ${o.name} where id = ${pid}`;
  if (o.category) {
    const cid = randomUUID();
    await ctx.sql`insert into categories (id, org_id, name) values (${cid}, ${shop.orgId}, ${o.category})`;
    await ctx.sql`update products set category_id = ${cid} where id = ${pid}`;
  }
  const card = (
    await ctx.sql`select id from tender_types where location_id = ${shop.locationId} and method = 'card'`
  )[0]!.id as string;
  const gross = 350 * qty;
  const vat = qty === 2 ? 131 : 65;
  const at = (o.at ?? new Date()).toISOString();
  const saleId = randomUUID();
  const p = {
    shift_id: o.shiftId ?? null,
    sale: {
      id: saleId,
      org_id: shop.orgId,
      register_id: shop.registerId,
      user_id: shop.cashier.userId,
      receipt_seq: o.seq,
      mode: "eat_in",
      completed_at: at,
      priced_as_of: at,
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
        name: o.name ?? "Tea",
        qty,
        unit_price_cents: 350,
        modifiers: [],
        discount_cents: 0,
        tax_category: "STANDARD",
        tax_rate_bp: 2300,
        net_cents: gross - vat,
        vat_cents: vat,
        gross_cents: gross,
        ...(o.serial ? { serial: o.serial } : {}),
      },
    ],
    payments: [
      {
        type_id: card,
        method: "card",
        amount: gross,
        tendered: gross,
        change: 0,
        tip: qty === 2 ? 50 : 0,
      },
    ],
  };
  const r = (await ctx.sql`select ops.record_sale(${json(ctx, p)}, ${shop.tokenHash}) as r`)[0]!
    .r as string;
  expect(r).toBe("created");
  return { saleId, vid, pid, card };
}

/** Refund one unit of the sale's first line (3.50 incl. 66c VAT) back to the card. */
async function refundOne(
  ctx: Ctx,
  shop: Shop,
  s: { saleId: string; card: string },
  seq = 1,
  shiftId: string | null = null,
) {
  const at = new Date();
  const p = {
    shift_id: shiftId,
    refund: {
      id: randomUUID(),
      org_id: shop.orgId,
      register_id: shop.registerId,
      user_id: shop.cashier.userId,
      original_sale_id: s.saleId,
      kind: "refund",
      reason_code: "changed_mind",
      receipt_seq: seq,
      completed_at: at.toISOString(),
      items_total: 350,
      vat: 66,
      non_vat: 0,
      credit: 0,
      cash_rounding: 0,
      amount: 350,
      client_amount: 350,
      exchange_sale_id: null,
    },
    lines: [{ line_no: 1, qty: 1, restock: true, gross_cents: 350, vat_cents: 66, net_cents: 284 }],
    payments: [{ type_id: s.card, method: "card", amount: 350, tip: 0 }],
  };
  const r = (await ctx.sql`select ops.record_refund(${json(ctx, p)}, ${shop.tokenHash}) as r`)[0]!
    .r as string;
  expect(r).toBe("created");
}

const rebuild = (ctx: Ctx, shop: Shop, day: string) =>
  ctx.sql`select ops.rebuild_summary_day(${shop.orgId}, ${shop.locationId}, ${day}::date)`;

/** postgres.js returns bigint as text: make the amounts numbers, leave key, label and day alone. */
const numbers = (rows: Record<string, unknown>[]) =>
  rows.map((r) =>
    Object.fromEntries(
      Object.entries(r).map(([k, v]) => [
        k,
        typeof v === "string" && /^-?\d+$/.test(v) && k !== "key" ? Number(v) : v,
      ]),
    ),
  );

const summary = async (ctx: Ctx, shop: Shop, day: string, dim: string, byDay = false) =>
  numbers(
    await ctx.as(
      shop.manager,
      () =>
        ctx.sql`select * from public.report_summary(${shop.orgId}, ${day}::date, ${day}::date, ${dim}, ${byDay})`,
    ),
  );

describe("daily_sales_summary", () => {
  it("sums the stored cents of a day, sales and refunds, for every cut", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await sell(ctx, a, { seq: 1, name: "Flat white", category: "Coffee" });
      await refundOne(ctx, a, s);
      const day = await localDay(ctx, new Date());
      await rebuild(ctx, a, day);

      const [total] = await summary(ctx, a, day, "total");
      expect(total).toMatchObject({
        key: "all",
        sales_count: 1,
        qty: 2,
        gross_cents: 700,
        net_cents: 569,
        vat_cents: 131,
        tips_cents: 50,
        refund_count: 1,
        refund_qty: 1,
        refund_gross_cents: 350,
        refund_net_cents: 284,
        refund_vat_cents: 66,
      });

      const [rate] = await summary(ctx, a, day, "vat_rate");
      expect(rate).toMatchObject({
        key: "2300",
        label: "23%",
        net_cents: 569,
        vat_cents: 131,
        gross_cents: 700,
        refund_net_cents: 284,
        refund_vat_cents: 66,
        refund_gross_cents: 350,
      });

      const [product] = await summary(ctx, a, day, "product");
      expect(product).toMatchObject({
        label: "Flat white",
        qty: 2,
        refund_qty: 1,
        gross_cents: 700,
      });
      const [category] = await summary(ctx, a, day, "category");
      expect(category).toMatchObject({
        label: "Coffee",
        gross_cents: 700,
        refund_gross_cents: 350,
      });
      const [staff] = await summary(ctx, a, day, "staff");
      expect(staff).toMatchObject({
        label: "cashier",
        sales_count: 1,
        gross_cents: 700,
        tips_cents: 50,
      });
      const tenders = await summary(ctx, a, day, "tender");
      expect(tenders).toHaveLength(1);
      expect(tenders[0]).toMatchObject({
        sales_count: 1,
        gross_cents: 700,
        tips_cents: 50,
        refund_count: 1,
        refund_gross_cents: 350,
      });
      const hours = await summary(ctx, a, day, "hour");
      expect(hours).toHaveLength(1);
      expect(hours[0]).toMatchObject({ sales_count: 1, gross_cents: 700, vat_cents: 131 });
    }));

  it("a rebuild twice gives the same rows (idempotent)", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      await sell(ctx, a, { seq: 1 });
      const day = await localDay(ctx, new Date());
      await rebuild(ctx, a, day);
      const first = await summary(ctx, a, day, "product");
      await rebuild(ctx, a, day);
      expect(await summary(ctx, a, day, "product")).toEqual(first);
      const n =
        await ctx.sql`select count(*)::int as n from daily_sales_summary where org_id = ${a.orgId}`;
      await rebuild(ctx, a, day);
      expect(
        (
          await ctx.sql`select count(*)::int as n from daily_sales_summary where org_id = ${a.orgId}`
        )[0]!.n,
      ).toBe(n[0]!.n);
    }));

  it("a late sale marks its own day, and the job rebuilds it and clears the mark", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const old = new Date(Date.now() - 5 * DAY);
      await sell(ctx, a, { seq: 1, at: old });
      const day = await localDay(ctx, old);
      const marked = await ctx.sql`
        select day::text from report_dirty_days where org_id = ${a.orgId}`;
      expect(marked.map((r) => r.day)).toContain(day);

      await ctx.sql`select ops.rebuild_dirty_summaries(500, 0)`;
      expect(
        (
          await ctx.sql`select count(*)::int as n from report_dirty_days where org_id = ${a.orgId}`
        )[0]!.n,
      ).toBe(0);
      const [total] = await summary(ctx, a, day, "total");
      expect(total).toMatchObject({ sales_count: 1, gross_cents: 700 });
    }));

  it("cuts days in the shop's own time zone", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      // UTC+14, no daylight saving: 09:30Z is 23:30 on D, 10:30Z is 00:30 on D+1.
      await ctx.sql`update locations set timezone = 'Etc/GMT-14' where id = ${a.locationId}`;
      const d = new Date(Date.now() - 3 * DAY);
      const ymd = d.toISOString().slice(0, 10);
      const late = new Date(`${ymd}T09:30:00Z`);
      const early = new Date(`${ymd}T10:30:00Z`);
      await sell(ctx, a, { seq: 1, at: late, qty: 1 });
      await sell(ctx, a, { seq: 2, at: early, qty: 1 });
      const next = new Date(d.getTime() + DAY).toISOString().slice(0, 10);
      await rebuild(ctx, a, ymd);
      await rebuild(ctx, a, next);
      expect((await summary(ctx, a, ymd, "total"))[0]).toMatchObject({
        sales_count: 1,
        gross_cents: 350,
      });
      expect((await summary(ctx, a, next, "total"))[0]).toMatchObject({
        sales_count: 1,
        gross_cents: 350,
      });
      expect((await summary(ctx, a, ymd, "hour"))[0]).toMatchObject({ key: "23", label: "23:00" });
      expect((await summary(ctx, a, next, "hour"))[0]).toMatchObject({ key: "00" });
    }));

  it("agrees with the Z-report of the shift that rang the sales", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const shiftId = randomUUID();
      const open = {
        kind: "open",
        id: shiftId,
        org_id: a.orgId,
        register_id: a.registerId,
        user_id: a.cashier.userId,
        at: new Date().toISOString(),
        float_cents: 1000,
      };
      await ctx.sql`select ops.record_shift_event(${a.tokenHash}, ${json(ctx, open)})`;
      const s = await sell(ctx, a, { seq: 1, shiftId });
      await sell(ctx, a, { seq: 2, shiftId, qty: 1 });
      await refundOne(ctx, a, s, 1, shiftId);
      const day = await localDay(ctx, new Date());
      await rebuild(ctx, a, day);

      const r = (await ctx.sql`select app.shift_report(${a.orgId}, ${shiftId}) as r`)[0]!.r;
      const z = r as {
        sales: { count: number; amount_due_cents: number; vat_cents: number };
        vat_by_rate: {
          rate_bp: number;
          net_cents: number;
          vat_cents: number;
          gross_cents: number;
        }[];
        tips_cents: number;
        refunds: { amount_cents: number; vat_cents: number };
      };
      const [total] = await summary(ctx, a, day, "total");
      expect(total).toMatchObject({
        sales_count: z.sales.count,
        gross_cents: z.sales.amount_due_cents,
        vat_cents: z.sales.vat_cents,
        tips_cents: z.tips_cents,
        refund_gross_cents: z.refunds.amount_cents,
        refund_vat_cents: z.refunds.vat_cents,
      });
      const [rate] = await summary(ctx, a, day, "vat_rate");
      expect(rate).toMatchObject({
        key: String(z.vat_by_rate[0]!.rate_bp),
        net_cents: z.vat_by_rate[0]!.net_cents,
        vat_cents: z.vat_by_rate[0]!.vat_cents,
        gross_cents: z.vat_by_rate[0]!.gross_cents,
      });
    }));
  it("an exchange counts the credit as returned, so takings after refunds are real money", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await sell(ctx, a, { seq: 1 }); // 7.00 on the card
      const exSale = randomUUID();
      const refundId = randomUUID();
      const now = new Date().toISOString();
      // One unit (3.50, VAT 66c) comes back as credit: nothing is paid out.
      const refund = {
        refund: {
          id: refundId,
          org_id: a.orgId,
          register_id: a.registerId,
          user_id: a.cashier.userId,
          original_sale_id: s.saleId,
          kind: "exchange",
          reason_code: "changed_mind",
          receipt_seq: 1,
          completed_at: now,
          items_total: 350,
          vat: 66,
          non_vat: 0,
          credit: 350,
          cash_rounding: 0,
          amount: 0,
          client_amount: 0,
          exchange_sale_id: exSale,
        },
        lines: [{ line_no: 1, qty: 1, restock: true, gross_cents: 350, vat_cents: 66, net_cents: 284 }],
        payments: [{ type_id: null, method: "exchange", amount: 350, tip: 0 }],
      };
      await ctx.sql`select ops.record_refund(${json(ctx, refund)}, ${a.tokenHash})`;
      // The new 5.00 sale (VAT 93): 3.50 credit + 1.50 cash.
      const cash = (
        await ctx.sql`select id from tender_types where location_id = ${a.locationId} and method = 'cash'`
      )[0]!.id as string;
      const sale = {
        sale: {
          id: exSale,
          org_id: a.orgId,
          register_id: a.registerId,
          user_id: a.cashier.userId,
          receipt_seq: 2,
          mode: "eat_in",
          completed_at: now,
          priced_as_of: now,
          items_total: 500,
          vat: 93,
          non_vat: 0,
          cash_rounding: 0,
          amount_due: 500,
          client_due: 500,
        },
        lines: [
          {
            kind: "item",
            variant_id: s.vid,
            product_id: s.pid,
            name: "Tea",
            qty: 1,
            unit_price_cents: 500,
            modifiers: [],
            discount_cents: 0,
            tax_category: "STANDARD",
            tax_rate_bp: 2300,
            net_cents: 407,
            vat_cents: 93,
            gross_cents: 500,
          },
        ],
        payments: [
          { method: "exchange", amount: 350, tendered: 350, change: 0, refund_id: refundId },
          { type_id: cash, method: "cash", amount: 150, tendered: 150, change: 0 },
        ],
      };
      const r = (await ctx.sql`select ops.record_sale(${json(ctx, sale)}, ${a.tokenHash}) as r`)[0]!.r;
      expect(r).toBe("created");

      const day = await localDay(ctx, new Date());
      await rebuild(ctx, a, day);
      const [total] = await summary(ctx, a, day, "total");
      // Real money in: 7.00 card + 1.50 cash = 8.50 = 12.00 sold - 3.50 returned as credit.
      expect(total).toMatchObject({ gross_cents: 1200, refund_gross_cents: 350, refund_vat_cents: 66 });
      const tenders = await summary(ctx, a, day, "tender");
      const exchange = tenders.find((t) => String(t.label).toLowerCase().includes("exchange"));
      expect(exchange).toMatchObject({ gross_cents: 350, refund_gross_cents: 350 }); // nets to nothing
    }));
});

describe("who can read a report", () => {
  it("managers and owners read their own shop; cashiers, anon and the other shop read nothing", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await sell(ctx, a, { seq: 1 });
      const day = await localDay(ctx, new Date());
      await rebuild(ctx, a, day);

      for (const who of [a.manager, a.owner]) {
        const rows = await ctx.as(
          who,
          () => ctx.sql`select * from daily_sales_summary where org_id = ${a.orgId}`,
        );
        expect(rows.length).toBeGreaterThan(0);
      }
      // Shop B's manager sees none of A's rows, directly or through the function.
      expect(
        await ctx.as(
          b.manager,
          () => ctx.sql`select * from daily_sales_summary where org_id = ${a.orgId}`,
        ),
      ).toHaveLength(0);
      await ctx.denied(
        () =>
          ctx.as(
            b.manager,
            () =>
              ctx.sql`select * from public.report_summary(${a.orgId}, ${day}::date, ${day}::date, 'total')`,
          ),
        ["42501"],
      );
      // A cashier reads no rows and gets an error from the function.
      expect(
        await ctx.as(
          a.cashier,
          () => ctx.sql`select * from daily_sales_summary where org_id = ${a.orgId}`,
        ),
      ).toHaveLength(0);
      await ctx.denied(
        () =>
          ctx.as(
            a.cashier,
            () =>
              ctx.sql`select * from public.report_summary(${a.orgId}, ${day}::date, ${day}::date, 'total')`,
          ),
        ["42501"],
      );
      await ctx.denied(
        () => ctx.as(null, () => ctx.sql`select * from daily_sales_summary`),
        ["42501"],
      );
    }));

  it("nobody can write the summary, read the dirty list or run the rebuild from the API", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const day = await localDay(ctx, new Date());
      await ctx.denied(() =>
        ctx.as(
          a.owner,
          () =>
            ctx.sql`insert into daily_sales_summary (org_id, location_id, day, dim, key, label)
                    values (${a.orgId}, ${a.locationId}, ${day}::date, 'total', 'all', 'x')`,
        ),
      );
      await ctx.denied(() => ctx.as(a.owner, () => ctx.sql`select * from report_dirty_days`));
      await ctx.denied(() =>
        ctx.as(
          a.owner,
          () => ctx.sql`select ops.rebuild_summary_day(${a.orgId}, ${a.locationId}, ${day}::date)`,
        ),
      );
    }));

  it("refuses a range that is backwards or longer than the database allows, and unknown cuts", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const call = (from: string, to: string, dim = "total") =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`select * from public.report_summary(${a.orgId}, ${from}::date, ${to}::date, ${dim})`,
        );
      await ctx.denied(() => call("2026-02-01", "2026-01-01"), ["22023"]);
      await ctx.denied(() => call("2024-01-01", "2026-01-01"), ["22023"]);
      await ctx.denied(() => call("2026-01-01", "2026-01-02", "everything"), ["22023"]);
    }));
});

describe("serial and cover reports", () => {
  it("lists serials sold, marks the ones that came back, and finds one by search", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const s = await sell(ctx, a, { seq: 1, qty: 1, serial: "IMEI-0001" });
      await sell(ctx, a, { seq: 2, qty: 1, serial: "IMEI-0002" });
      const day = await localDay(ctx, new Date());
      const run = (search: string | null) =>
        ctx.as(
          a.manager,
          () =>
            ctx.sql`select * from public.report_serials(${a.orgId}, ${day}::date, ${day}::date, ${search})`,
        );
      expect((await run(null)).map((r) => r.serial).sort()).toEqual(["IMEI-0001", "IMEI-0002"]);
      expect((await run("0002")).map((r) => r.serial)).toEqual(["IMEI-0002"]);
      expect((await run(null)).every((r) => r.returned === false)).toBe(true);

      // A refund of the unit flags it as returned (one unit, so the whole line goes back).
      const p = {
        refund: {
          id: randomUUID(),
          org_id: a.orgId,
          register_id: a.registerId,
          user_id: a.cashier.userId,
          original_sale_id: s.saleId,
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
          exchange_sale_id: null,
        },
        lines: [
          {
            line_no: 1,
            qty: 1,
            restock: true,
            gross_cents: 350,
            vat_cents: 65,
            net_cents: 285,
            serial: "IMEI-0001",
          },
        ],
        payments: [{ type_id: s.card, method: "card", amount: 350, tip: 0 }],
      };
      await ctx.sql`select ops.record_refund(${json(ctx, p)}, ${a.tokenHash})`;
      const after = await run("0001");
      expect(after).toHaveLength(1);
      expect(after[0]!.returned).toBe(true);

      await ctx.denied(
        () =>
          ctx.as(
            a.cashier,
            () =>
              ctx.sql`select * from public.report_serials(${a.orgId}, ${day}::date, ${day}::date)`,
          ),
        ["42501"],
      );
      await ctx.denied(
        () =>
          ctx.as(
            ctx.world.b.manager,
            () =>
              ctx.sql`select * from public.report_serials(${a.orgId}, ${day}::date, ${day}::date)`,
          ),
        ["42501"],
      );
    }));

  it("counts covers and the takings of tabs per day", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const tab = randomUUID();
      await ctx.sql`insert into tab_events (id, org_id, tab_id, register_id, kind, cashier_user_id, at, detail)
                    values (${randomUUID()}, ${a.orgId}, ${tab}, ${a.registerId}, 'open', ${a.cashier.userId},
                            now(), '{"covers": 4}'::jsonb)`;
      const s = await sell(ctx, a, { seq: 1 });
      await ctx.sql`insert into sale_tabs (sale_id, org_id, tab_id) values (${s.saleId}, ${a.orgId}, ${tab})`;
      const day = await localDay(ctx, new Date());
      const rows = await ctx.as(
        a.manager,
        () => ctx.sql`select * from public.report_covers(${a.orgId}, ${day}::date, ${day}::date)`,
      );
      expect(rows).toHaveLength(1);
      expect(numbers(rows)[0]).toMatchObject({ tabs: 1, covers: 4, sales_cents: 700 });
      expect((rows[0]!.day as Date).toISOString().slice(0, 10)).toBe(day);
      await ctx.denied(
        () =>
          ctx.as(
            a.cashier,
            () =>
              ctx.sql`select * from public.report_covers(${a.orgId}, ${day}::date, ${day}::date)`,
          ),
        ["42501"],
      );
    }));
});
