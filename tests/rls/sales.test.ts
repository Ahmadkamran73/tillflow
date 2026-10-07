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
      await denied(() => reject(ctx, rejection(world.a, { register_id: world.b.registerId })));
    }));

  it("a sale naming someone who is not staff here is still recorded as a rejection, with no actor", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      // The till is authenticated by its device token, so a bad cashier id must not block the queue.
      const r = rejection(world.a, { user_id: world.b.owner.userId });
      await reject(ctx, r);
      expect(await sql`select 1 from sync_rejections where id = ${r.id}`).toHaveLength(1);
      const audit = await sql`select actor_user_id from audit_log
        where entity_id = ${r.id} and action = 'sale.sync_rejected'`;
      expect(audit).toEqual([{ actor_user_id: null }]); // Shop B's owner is never named in Shop A's log
      // Nor a missing id.
      const none = rejection(world.a, { user_id: null });
      await reject(ctx, none);
      expect(await sql`select 1 from sync_rejections where id = ${none.id}`).toHaveLength(1);
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
      await sql`select pg_sleep(0.02)`; // a JS Date keeps milliseconds, the database microseconds
      const t0 = (await sql`select clock_timestamp() as t`)[0]!.t as Date;
      await sql`select pg_sleep(0.02)`;
      await sql`select pg_sleep(0.02)`;
      await sql`update variants set price_incl_vat_cents = 500 where id = ${vid}`;
      await sql`select pg_sleep(0.02)`; // a JS Date keeps milliseconds, the database microseconds
      const t1 = (await sql`select clock_timestamp() as t`)[0]!.t as Date;
      await sql`select pg_sleep(0.02)`;
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
      await sql`select pg_sleep(0.02)`; // a JS Date keeps milliseconds, the database microseconds
      const before = (await sql`select clock_timestamp() as t`)[0]!.t as Date;
      await sql`select pg_sleep(0.02)`;
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

describe("stock ledger scoping for cashiers", () => {
  it("a cashier sees opening stock, adjustments and their own sales, not other cashiers' sales", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      await sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason)
                values (${randomUUID()}, ${world.a.orgId}, ${vid}, ${world.a.locationId}, 20, 'opening')`;
      await record(ctx, salePayload(world.a, vid, pid, { receipt_seq: 1 })); // by the cashier
      await record(
        ctx,
        salePayload(world.a, vid, pid, {
          id: randomUUID(),
          receipt_seq: 2,
          user_id: world.a.manager.userId,
        }),
      );
      const reasons = async (actor: Shop["owner"]) =>
        (await as(actor, () => sql`select reason, actor_user_id from stock_movements`)).map(
          (r) => `${r.reason}:${r.actor_user_id === actor.userId ? "me" : "other"}`,
        );
      expect((await reasons(world.a.cashier)).sort()).toEqual(["opening:other", "sale:me"]);
      expect((await reasons(world.a.manager)).sort()).toEqual([
        "opening:other",
        "sale:me",
        "sale:other",
      ]);
      expect(await as(world.a.cashier, () => sql`select on_hand from stock_levels`)).toHaveLength(
        1,
      );
    }));
});

describe("sales_known (replay dedupe)", () => {
  it("tells a cashier a sale already exists even when RLS hides it, but only inside their own shop", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      const b = await seedProduct(ctx, world.b.orgId);
      const theirs = salePayload(world.a, a.vid, a.pid, { user_id: world.a.manager.userId });
      const other = salePayload(world.b, b.vid, b.pid);
      await record(ctx, theirs);
      await record(ctx, other);
      const known = (actor: Shop["owner"], org: string, ids: string[]) =>
        as(actor, () => sql`select * from public.sales_known(${org}, ${ids}::uuid[])`);

      expect(await as(world.a.cashier, () => sql`select 1 from sales`)).toHaveLength(0); // hidden
      expect(
        (await known(world.a.cashier, world.a.orgId, [theirs.sale.id])).map((r) => r.sales_known),
      ).toEqual([theirs.sale.id]);
      // Another shop's member learns nothing, whichever org they name.
      expect(await known(world.b.cashier, world.a.orgId, [theirs.sale.id])).toHaveLength(0);
      expect(await known(world.a.cashier, world.b.orgId, [other.sale.id])).toHaveLength(0);
      expect(await known(world.a.cashier, world.a.orgId, [other.sale.id])).toHaveLength(0);
    }));
});

describe("ops.record_sale re-checks (Phase 1 hardening)", () => {
  const withToken = async (ctx: Ctx, p: unknown, token: string | null) =>
    (await ctx.sql`select ops.record_sale(${json(ctx, p)}, ${token}) as r`)[0]!.r as string;

  it("a sale that does not add up is refused, whichever sum is wrong", () =>
    inWorld(async (ctx) => {
      const { world, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const bad: ((p: ReturnType<typeof salePayload>) => void)[] = [
        (p) => (p.lines[0]!.net_cents = 570), // net + VAT is not the gross
        (p) => (p.sale.items_total = 701),
        (p) => (p.sale.vat = 130),
        (p) => (p.sale.non_vat = 15),
        (p) => (p.sale.cash_rounding = 3),
        (p) => (p.sale.amount_due = 705),
        (p) => (p.payment.amount = 650),
        (p) => (p.payment.tendered = 600),
        (p) => (p.payment.change = 250),
        // Adds up, but the VAT is split at the wrong rate (9% instead of the line's 23%).
        (p) => {
          p.lines[0]!.net_cents = 642;
          p.lines[0]!.vat_cents = 58;
        },
        (p) => (p.lines[0]!.tax_rate_bp = 10_001),
        // The discount must be what the full price lost (2 x 350 - 700 = 0).
        (p) => (p.lines[0]!.discount_cents = 50),
        // A cash total that is not a multiple of 5c, though within 2c of the items.
        (p) => {
          p.sale.cash_rounding = 2;
          p.sale.amount_due = 702;
          p.payment.amount = 702;
          p.payment.change = 298;
        },
        // A kind of line the server never writes.
        (p) => (p.lines[0]!.kind = "levy"),
        // vat_differs without the till's VAT to back it.
        (p) => ((p.sale as Record<string, unknown>).review_flags = ["vat_differs"]),
      ];
      for (const [i, spoil] of bad.entries()) {
        const p = salePayload(world.a, vid, pid, { receipt_seq: i + 1 });
        spoil(p);
        await denied(() => record(ctx, p), ["22023"]);
      }
      expect(await counts(ctx, world.a.orgId)).toMatchObject({ sales: 0, lines: 0, payments: 0 });
    }));

  it("with a device token, only that till's own shop and register are accepted", () =>
    inWorld(async (ctx) => {
      const { sql, world, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const p = salePayload(world.a, vid, pid);
      await denied(() => withToken(ctx, p, world.b.tokenHash));
      await denied(() => withToken(ctx, p, "0".repeat(64)));
      expect(await withToken(ctx, p, world.a.tokenHash)).toBe("created");
      // A second till of the same shop cannot record a sale as the first one.
      const other = randomUUID();
      await sql`insert into registers (id, org_id, location_id, name, device_token_hash)
                values (${other}, ${world.a.orgId}, ${world.a.locationId}, 'Till 2', ${"f".repeat(64)})`;
      const q = salePayload(world.a, vid, pid, { id: randomUUID(), receipt_seq: 9 });
      await denied(() => withToken(ctx, q, "f".repeat(64)));
      // A till cannot name its own approver: approved_by is ignored with a token, so no override row.
      const r = salePayload(world.a, vid, pid, {
        id: randomUUID(),
        receipt_seq: 10,
        approved_by: world.a.owner.userId,
      });
      expect(await withToken(ctx, r, world.a.tokenHash)).toBe("created");
      expect(
        await sql`select 1 from audit_log where entity_id = ${r.sale.id} and action = 'sale.discount_override'`,
      ).toHaveLength(0);
    }));

  it("stores the till's VAT and the review flags; an unknown flag is refused", () =>
    inWorld(async (ctx) => {
      const { sql, world, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const p = salePayload(world.a, vid, pid, {
        client_vat: 120,
        review_flags: ["vat_differs", "old_prices"],
      });
      expect(await record(ctx, p)).toBe("created");
      const [row] =
        await sql`select client_vat_cents, review_flags from sales where id = ${p.sale.id}`;
      expect(row).toEqual({ client_vat_cents: 120, review_flags: ["vat_differs", "old_prices"] });

      const odd = salePayload(world.a, vid, pid, { receipt_seq: 2, review_flags: ["made_up"] });
      await denied(() => record(ctx, odd), ["23514"]);
    }));

  it("a manager marks a flagged sale reviewed once; cashiers and Shop B cannot", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const flagged = salePayload(world.a, vid, pid, { review_flags: ["old_prices"] });
      const plain = salePayload(world.a, vid, pid, { id: randomUUID(), receipt_seq: 2 });
      await record(ctx, flagged);
      await record(ctx, plain);
      const review = (actor: Parameters<Ctx["as"]>[0], id: string) =>
        as(actor, () => sql`select public.mark_sale_reviewed(${id}, 'Checked', ${randomUUID()})`);

      for (const actor of [world.a.cashier, world.b.manager, world.b.owner, null]) {
        await denied(() => review(actor, flagged.sale.id));
      }
      await denied(() => review(world.a.manager, plain.sale.id)); // nothing to review
      await review(world.a.manager, flagged.sale.id);
      await review(world.a.owner, flagged.sale.id); // already reviewed: no second row
      const rows = await sql`select actor_user_id, after from audit_log
        where org_id = ${world.a.orgId} and action = 'sale.reviewed' and entity_id = ${flagged.sale.id}`;
      expect(rows).toEqual([{ actor_user_id: world.a.manager.userId, after: { note: "Checked" } }]);
    }));
});

describe("public.sales_to_review", () => {
  it("leaves reviewed sales out before the limit, so they can never hide an unreviewed one", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const old = salePayload(world.a, vid, pid, { receipt_seq: 1, review_flags: ["old_prices"] });
      await record(ctx, old);
      // Three newer flagged sales, all reviewed.
      for (const seq of [2, 3, 4]) {
        const p = salePayload(world.a, vid, pid, {
          id: randomUUID(),
          receipt_seq: seq,
          review_flags: ["old_prices"],
        });
        await record(ctx, p);
        await as(
          world.a.manager,
          () => sql`select public.mark_sale_reviewed(${p.sale.id}, '', ${randomUUID()})`,
        );
      }
      const list = (actor: Parameters<Ctx["as"]>[0], limit: number) =>
        as(actor, () => sql`select id from public.sales_to_review(${world.a.orgId}, ${limit})`);
      // Limit 1: still the old, unreviewed sale.
      expect(await list(world.a.manager, 1)).toEqual([{ id: old.sale.id }]);
      // RLS decides what others see: Shop B and a cashier get nothing; anon cannot call it.
      expect(await list(world.b.manager, 10)).toHaveLength(0);
      expect(await list(world.a.cashier, 10)).toHaveLength(0);
      await denied(() => list(null, 10));
    }));
});
