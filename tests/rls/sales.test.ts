// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedGroup, seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);

/** A consistent two-unit sale of the seeded €3.50 tea (VAT-inclusive, 23%). */
function salePayload(shop: Shop, vid: string, pid: string, over: Record<string, unknown> = {}) {
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
    payment: { method: "cash", amount: 700, tendered: 1000, change: 300 },
  };
}

const record = async (ctx: Ctx, p: unknown) =>
  (await ctx.sql`select ops.record_sale(${json(ctx, p)}) as r`)[0]!.r as string;

const counts = async (ctx: Ctx, orgId: string) => {
  const [r] = await ctx.sql`
    select (select count(*) from sales where org_id = ${orgId})::int as sales,
           (select count(*) from sale_lines where org_id = ${orgId})::int as lines,
           (select count(*) from payments where org_id = ${orgId})::int as payments,
           (select count(*) from stock_movements where org_id = ${orgId} and reason = 'sale')::int as moves`;
  return r!;
};

describe("ops.record_sale", () => {
  it("writes sale, lines, payment and one stock movement together; a replay changes nothing", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      await sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason)
                values (${randomUUID()}, ${world.a.orgId}, ${vid}, ${world.a.locationId}, 50, 'opening')`;
      const p = salePayload(world.a, vid, pid);

      expect(await record(ctx, p)).toBe("created");
      expect(await counts(ctx, world.a.orgId)).toEqual({
        sales: 1,
        lines: 1,
        payments: 1,
        moves: 1,
      });
      expect(
        (await sql`select on_hand from stock_levels where variant_id = ${vid}`)[0]!.on_hand,
      ).toBe(48);

      expect(await record(ctx, p)).toBe("duplicate");
      expect(await record(ctx, p)).toBe("duplicate");
      expect(await counts(ctx, world.a.orgId)).toEqual({
        sales: 1,
        lines: 1,
        payments: 1,
        moves: 1,
      });
      expect(
        (await sql`select on_hand from stock_levels where variant_id = ${vid}`)[0]!.on_hand,
      ).toBe(48);

      const [sale] =
        await sql`select location_id, cashier_user_id from sales where id = ${p.sale.id}`;
      expect(sale).toMatchObject({
        location_id: world.a.locationId,
        cashier_user_id: world.a.cashier.userId,
      });
      expect(
        (await sql`select last_seen_at from registers where id = ${world.a.registerId}`)[0]!
          .last_seen_at,
      ).not.toBeNull();
    }));

  it("lets stock go negative and skips untracked products", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      await record(ctx, salePayload(world.a, vid, pid, { receipt_seq: 1 }));
      expect(
        (await sql`select on_hand from stock_levels where variant_id = ${vid}`)[0]!.on_hand,
      ).toBe(-2);

      const other = await seedProduct(ctx, world.a.orgId, "999");
      await sql`update products set track_stock = false where id = ${other.pid}`;
      await record(
        ctx,
        salePayload(world.a, other.vid, other.pid, { id: randomUUID(), receipt_seq: 2 }),
      );
      expect(await sql`select 1 from stock_levels where variant_id = ${other.vid}`).toHaveLength(0);
    }));

  it("refuses a user outside the org and a register of another org", () =>
    inWorld(async (ctx) => {
      const { world, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const stranger = salePayload(world.a, vid, pid, { user_id: world.b.owner.userId });
      await denied(() => record(ctx, stranger));
      const foreignRegister = salePayload(world.a, vid, pid, { register_id: world.b.registerId });
      await denied(() => record(ctx, foreignRegister));
      expect((await counts(ctx, world.a.orgId)).sales).toBe(0);
    }));

  it("a repeated receipt number on a till with a different sale id is a clash, not a second sale", () =>
    inWorld(async (ctx) => {
      const { world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      expect(await record(ctx, salePayload(world.a, vid, pid, { receipt_seq: 7 }))).toBe("created");
      const second = salePayload(world.a, vid, pid, { id: randomUUID(), receipt_seq: 7 });
      expect(await record(ctx, second)).toBe("receipt_clash");
      expect((await counts(ctx, world.a.orgId)).sales).toBe(1);
    }));

  it("a sale id already used by another shop is never reported as a duplicate for this one", () =>
    inWorld(async (ctx) => {
      const { world, denied } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      const b = await seedProduct(ctx, world.b.orgId);
      const p = salePayload(world.a, a.vid, a.pid);
      await record(ctx, p);
      const hijack = salePayload(world.b, b.vid, b.pid, { id: p.sale.id });
      await denied(() => record(ctx, hijack), ["23505"]);
      expect((await counts(ctx, world.b.orgId)).sales).toBe(0);
    }));

  it("a taxed line must carry its VAT snapshot; totals must be within 1c of the till's", () =>
    inWorld(async (ctx) => {
      const { world, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const noRate = salePayload(world.a, vid, pid);
      delete (noRate.lines[0] as Record<string, unknown>).tax_rate_bp;
      await denied(() => record(ctx, noRate), ["23514"]);
      await denied(
        () => record(ctx, salePayload(world.a, vid, pid, { client_due: 703 })),
        ["23514"],
      );
    }));
});

describe("sales tables: RLS and append-only", () => {
  it("a cashier reads only the sales they rang up; managers and owners read the shop's", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const mine = salePayload(world.a, vid, pid, { receipt_seq: 1 });
      const theirs = salePayload(world.a, vid, pid, {
        id: randomUUID(),
        receipt_seq: 2,
        user_id: world.a.manager.userId,
      });
      await record(ctx, mine);
      await record(ctx, theirs);

      const ids = async (actor: Shop["owner"], table: string) =>
        (
          await as(
            actor,
            () => sql`select ${sql(table === "sales" ? "id" : "sale_id")} as k from ${sql(table)}`,
          )
        ).map((r) => r.k as string);
      for (const table of ["sales", "sale_lines", "payments"]) {
        expect(await ids(world.a.cashier, table)).toEqual([mine.sale.id]);
        expect((await ids(world.a.manager, table)).sort()).toEqual(
          [mine.sale.id, theirs.sale.id].sort(),
        );
        expect((await ids(world.a.owner, table)).sort()).toEqual(
          [mine.sale.id, theirs.sale.id].sort(),
        );
      }
      // The cashier still gets the shop's real last receipt number, so numbers are never reused.
      const seqs = await as(
        world.a.cashier,
        () => sql`select * from public.register_last_seqs(${world.a.orgId})`,
      );
      expect(seqs).toEqual([{ register_id: world.a.registerId, last_seq: 2 }]);
    }));

  it("members read their shop's sales; Shop B and anon see nothing of Shop A", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      const b = await seedProduct(ctx, world.b.orgId);
      const pa = salePayload(world.a, a.vid, a.pid);
      await record(ctx, pa);
      await record(ctx, salePayload(world.b, b.vid, b.pid));

      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        for (const table of ["sales", "sale_lines", "payments"] as const) {
          const rows = await as(actor, () => sql`select org_id from ${sql(table)}`);
          expect(rows.map((r) => r.org_id)).toEqual([world.a.orgId]);
        }
      }
      for (const table of ["sales", "sale_lines", "payments"] as const) {
        const rows = await as(world.b.owner, () => sql`select org_id from ${sql(table)}`);
        expect(rows.map((r) => r.org_id)).toEqual([world.b.orgId]);
        const none = await as(
          world.b.cashier,
          () => sql`select 1 from ${sql(table)} where org_id = ${world.a.orgId}`,
        );
        expect(none).toHaveLength(0);
      }
      await ctx.denied(() => as(null, () => sql`select * from sales`));
      expect(
        await as(world.b.manager, () => sql`select 1 from sales where id = ${pa.sale.id}`),
      ).toHaveLength(0);
    }));

  it("no client can insert, update or delete; the triggers also stop privileged roles", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const p = salePayload(world.a, vid, pid);
      await record(ctx, p);

      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        await denied(() =>
          as(
            actor,
            () => sql`insert into sales (id, org_id, register_id, location_id, receipt_seq, completed_at,
                       priced_as_of, cashier_user_id, items_total_cents, vat_cents, non_vat_cents,
                       cash_rounding_cents, amount_due_cents, client_due_cents)
                     values (${randomUUID()}, ${world.a.orgId}, ${world.a.registerId}, ${world.a.locationId},
                       9, now(), now(), ${actor.userId}, 1, 0, 0, 0, 1, 1)`,
          ),
        );
        for (const table of ["sales", "sale_lines", "payments"] as const) {
          await denied(() => as(actor, () => sql`update ${sql(table)} set org_id = org_id`));
          await denied(() => as(actor, () => sql`delete from ${sql(table)}`));
        }
      }
      // Even the connection that owns the tables is refused (trigger), UPDATE, DELETE and TRUNCATE.
      for (const table of ["sales", "sale_lines", "payments"] as const) {
        await denied(() => sql`update ${sql(table)} set org_id = org_id`);
        await denied(() => sql`delete from ${sql(table)}`);
        await denied(() => sql`truncate ${sql(table)} cascade`);
      }
      expect((await counts(ctx, world.a.orgId)).sales).toBe(1);
    }));

  it("ops.record_sale and the other ops sync functions are not callable by clients", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const p = salePayload(world.a, vid, pid);
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        await denied(() => as(actor, () => sql`select ops.record_sale(${json(ctx, p)})`));
        await denied(() =>
          as(actor, () => sql`select ops.record_sync_rejection(${json(ctx, {})})`),
        );
        await denied(() =>
          as(
            actor,
            () =>
              sql`select ops.touch_register(${world.a.orgId}, ${world.a.registerId}, ${actor.userId})`,
          ),
        );
      }
      await denied(() => as(null, () => sql`select ops.record_sale(${json(ctx, p)})`));
    }));
});

describe("sync_rejections", () => {
  const rejection = (shop: Shop, over: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    org_id: shop.orgId,
    register_id: shop.registerId,
    user_id: shop.cashier.userId,
    reason: "price_mismatch",
    detail: { tillDueCents: 1, serverDueCents: 5 },
    payload: { cashierUserId: shop.cashier.userId },
    ...over,
  });
  const reject = (ctx: Ctx, p: unknown) =>
    ctx.sql`select ops.record_sync_rejection(${json(ctx, p)})`;

  it("is recorded once with an audit row, readable by managers and owners only", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const r = rejection(world.a);
      await reject(ctx, r);
      await reject(ctx, r); // replay
      expect(await sql`select 1 from sync_rejections where id = ${r.id}`).toHaveLength(1);
      expect(
        await sql`select 1 from audit_log where entity_id = ${r.id} and action = 'sale.sync_rejected'`,
      ).toHaveLength(1);

      for (const actor of [world.a.owner, world.a.manager]) {
        expect(await as(actor, () => sql`select id from sync_rejections`)).toHaveLength(1);
      }
      expect(await as(world.a.cashier, () => sql`select id from sync_rejections`)).toHaveLength(0);
      expect(await as(world.b.owner, () => sql`select id from sync_rejections`)).toHaveLength(0);
      expect(await as(world.b.manager, () => sql`select id from sync_rejections`)).toHaveLength(0);
    }));

  it("is never recorded for a sale that is already on the server, nor across shops", () =>
    inWorld(async (ctx) => {
      const { sql, world, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const p = salePayload(world.a, vid, pid);
      await record(ctx, p);
      await reject(ctx, rejection(world.a, { id: p.sale.id }));
      expect(await sql`select 1 from sync_rejections where id = ${p.sale.id}`).toHaveLength(0);
      await denied(() => reject(ctx, rejection(world.a, { user_id: world.b.owner.userId })));
      await denied(() => reject(ctx, rejection(world.a, { register_id: world.b.registerId })));
    }));

  it("only a manager of that shop can resolve it, with a note, once, with an audit row", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const r = rejection(world.a);
      await reject(ctx, r);
      const resolve = (actor: Shop["manager"], note: string | null) =>
        as(
          actor,
          () => sql`select public.resolve_sync_rejection(${r.id}, ${note}, ${randomUUID()})`,
        );

      await denied(() => resolve(world.a.cashier, "ok"));
      await denied(() => resolve(world.b.owner, "ok"));
      await denied(() => resolve(world.b.manager, "ok"));
      await denied(() => resolve(world.a.manager, ""), ["22023"]);
      await denied(() => resolve(world.a.manager, null), ["22023"]);

      await resolve(world.a.manager, "  Refunded the difference ");
      const [row] =
        await sql`select status, note, resolved_by from sync_rejections where id = ${r.id}`;
      expect(row).toMatchObject({
        status: "resolved",
        note: "Refunded the difference",
        resolved_by: world.a.manager.userId,
      });
      await resolve(world.a.owner, "again"); // idempotent: no second audit row
      expect(
        await sql`select 1 from audit_log where entity_id = ${r.id} and action = 'sale.sync_rejection_resolved'`,
      ).toHaveLength(1);
      // Clients cannot write the table directly.
      await denied(() =>
        as(
          world.a.manager,
          () => sql`update sync_rejections set status = 'open' where id = ${r.id}`,
        ),
      );
    }));
});

describe("price history and as-of catalogue", () => {
  it("records a row per price change and returns the price in force at a moment", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const t0 = (await sql`select clock_timestamp() as t`)[0]!.t as Date;
      await sql`select pg_sleep(0.02)`;
      await sql`update variants set price_incl_vat_cents = 500 where id = ${vid}`;
      const t1 = (await sql`select clock_timestamp() as t`)[0]!.t as Date;
      await sql`select pg_sleep(0.02)`;
      await sql`update variants set price_incl_vat_cents = 500 where id = ${vid}`; // no change: no row
      await sql`update variants set price_incl_vat_cents = 900 where id = ${vid}`;
      expect(await sql`select 1 from variant_price_history where variant_id = ${vid}`).toHaveLength(
        3,
      );

      const at = async (when: Date) =>
        (
          await as(
            world.a.cashier,
            () =>
              sql`select public.sale_catalog_as_of(${world.a.orgId}, ${[vid]}::uuid[], '{}'::uuid[], ${when}) as c`,
          )
        )[0]!.c as {
          variants: { price_cents: number; tax_category: string }[];
          products: { id: string }[];
        };
      expect((await at(t0)).variants[0]!.price_cents).toBe(350);
      expect((await at(t1)).variants[0]!.price_cents).toBe(500);
      expect((await at(new Date(Date.now() + 60_000))).variants[0]!.price_cents).toBe(900);
      expect((await at(new Date())).products[0]!.id).toBe(pid);
      // Before the product existed: nothing.
      expect((await at(new Date("2000-01-01"))).variants).toHaveLength(0);
    }));

  it("follows VAT category changes, deposits and take-away categories", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const before = (await sql`select clock_timestamp() as t`)[0]!.t as Date;
      await sql`select pg_sleep(0.02)`;
      await sql`update products set tax_category = 'CATERING', takeaway_tax_category = 'ZERO' where id = ${pid}`;
      await sql`update variants set attributes = '{"depositCents": 15}'::jsonb where id = ${vid}`;
      const get = async (when: Date) =>
        (
          await as(
            world.a.manager,
            () =>
              sql`select public.sale_catalog_as_of(${world.a.orgId}, ${[vid]}::uuid[], '{}'::uuid[], ${when}) as c`,
          )
        )[0]!.c as {
          variants: {
            tax_category: string;
            takeaway_tax_category: string | null;
            attributes: Record<string, unknown>;
          }[];
        };
      expect((await get(before)).variants[0]).toMatchObject({
        tax_category: "STANDARD",
        takeaway_tax_category: null,
      });
      expect((await get(new Date(Date.now() + 60_000))).variants[0]).toMatchObject({
        tax_category: "CATERING",
        takeaway_tax_category: "ZERO",
        attributes: { depositCents: 15 },
      });
    }));

  it("keeps a deleted modifier priceable, and never shows another shop's catalogue", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      const { gid, oid } = await seedGroup(ctx, world.a.orgId);
      await sql`insert into product_modifier_groups (id, org_id, product_id, group_id)
                values (${randomUUID()}, ${world.a.orgId}, ${a.pid}, ${gid})`;
      await sql`delete from modifiers where id = ${oid}`;

      const ask = (actor: Shop["manager"], org: string) =>
        as(
          actor,
          () =>
            sql`select public.sale_catalog_as_of(${org}, ${[a.vid]}::uuid[], ${[oid]}::uuid[], now() + interval '1 minute') as c`,
        );
      const mine = (await ask(world.a.cashier, world.a.orgId))[0]!.c as {
        modifiers: { price_delta_cents: number }[];
        product_groups: unknown[];
      };
      expect(mine.modifiers[0]!.price_delta_cents).toBe(50);
      expect(mine.product_groups).toHaveLength(1);

      for (const [actor, org] of [
        [world.b.owner, world.a.orgId],
        [world.b.cashier, world.a.orgId],
        [world.a.owner, world.b.orgId],
      ] as const) {
        const c = (await ask(actor, org))[0]!.c as { variants: unknown[]; modifiers: unknown[] };
        expect(c.variants).toHaveLength(0);
        expect(c.modifiers).toHaveLength(0);
      }
    }));

  it("history tables are read-only for clients and members see only their own shop", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      await seedProduct(ctx, world.b.orgId);
      await seedGroup(ctx, world.a.orgId); // so modifier_price_history has a row for the trigger to refuse
      for (const table of ["variant_price_history", "modifier_price_history"] as const) {
        const rows = await as(world.a.cashier, () => sql`select org_id from ${sql(table)}`);
        expect(rows.every((r) => r.org_id === world.a.orgId)).toBe(true);
        await denied(() => as(world.a.owner, () => sql`delete from ${sql(table)}`));
        await denied(() => sql`update ${sql(table)} set org_id = org_id`);
      }
      await denied(() =>
        as(
          world.a.owner,
          () => sql`insert into variant_price_history (org_id, variant_id, product_id, price_incl_vat_cents, tax_category)
                    values (${world.a.orgId}, ${a.vid}, ${a.pid}, 1, 'STANDARD')`,
        ),
      );
    }));
});

describe("register_last_seqs", () => {
  it("returns the highest receipt number per till, for the caller's shop only", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      await record(ctx, salePayload(world.a, a.vid, a.pid, { id: randomUUID(), receipt_seq: 3 }));
      await record(ctx, salePayload(world.a, a.vid, a.pid, { id: randomUUID(), receipt_seq: 12 }));
      const rows = await as(
        world.a.cashier,
        () => sql`select * from public.register_last_seqs(${world.a.orgId})`,
      );
      expect(rows).toEqual([{ register_id: world.a.registerId, last_seq: 12 }]);
      expect(
        await as(
          world.b.owner,
          () => sql`select * from public.register_last_seqs(${world.a.orgId})`,
        ),
      ).toHaveLength(0);
    }));
});
