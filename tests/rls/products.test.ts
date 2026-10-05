// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";
import { payload, seedProduct } from "./catalog-helpers";

afterAll(() => sql.end());

describe("products and variants RLS", () => {
  it("members see only their own; anon sees nothing", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      await seedProduct(ctx, world.b.orgId);
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        expect((await as(actor, () => sql`select id from products`)).map((r) => r.id)).toEqual([
          a.pid,
        ]);
        expect((await as(actor, () => sql`select id from variants`)).map((r) => r.id)).toEqual([
          a.vid,
        ]);
      }
      await denied(() => as(null, () => sql`select id from products`));
      await denied(() => as(null, () => sql`select id from variants`));
    }));

  it("owner and manager write; cashier cannot; nobody deletes", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      for (const actor of [world.a.owner, world.a.manager]) {
        expect(
          await as(
            actor,
            () => sql`update products set name = 'Coffee' where id = ${pid} returning id`,
          ),
        ).toHaveLength(1);
        expect(
          await as(
            actor,
            () =>
              sql`update variants set price_incl_vat_cents = 400 where id = ${vid} returning id`,
          ),
        ).toHaveLength(1);
      }
      expect(
        await as(
          world.a.cashier,
          () => sql`update products set name = 'X' where id = ${pid} returning id`,
        ),
      ).toHaveLength(0);
      await denied(() =>
        as(
          world.a.cashier,
          () =>
            sql`insert into products (id, org_id, name, tax_category) values (${randomUUID()}, ${world.a.orgId}, 'N', 'ZERO')`,
        ),
      );
      for (const actor of [world.a.owner, world.a.manager]) {
        await denied(() => as(actor, () => sql`delete from variants where id = ${vid}`));
        await denied(() => as(actor, () => sql`delete from products where id = ${pid}`));
      }
    }));

  it("Shop A cannot write into or reach Shop B", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const b = await seedProduct(ctx, world.b.orgId);
      const own = await seedProduct(ctx, world.a.orgId);
      const bCat = randomUUID();
      await sql`insert into categories (id, org_id, name) values (${bCat}, ${world.b.orgId}, 'B cat')`;
      const m = world.a.manager;
      await denied(() =>
        as(
          m,
          () =>
            sql`insert into products (id, org_id, name, tax_category) values (${randomUUID()}, ${world.b.orgId}, 'X', 'ZERO')`,
        ),
      );
      // Own org id but a foreign category or product: the composite FKs refuse.
      await denied(() =>
        as(
          m,
          () =>
            sql`insert into products (id, org_id, name, tax_category, category_id) values (${randomUUID()}, ${world.a.orgId}, 'X', 'ZERO', ${bCat})`,
        ),
      );
      await denied(() =>
        as(
          m,
          () =>
            sql`insert into variants (id, org_id, product_id, price_incl_vat_cents) values (${randomUUID()}, ${world.a.orgId}, ${b.pid}, 1)`,
        ),
      );
      // Foreign rows are invisible, so updates touch nothing; org_id is not updatable at all.
      expect(
        await as(
          m,
          () => sql`update products set name = 'Hacked' where id = ${b.pid} returning id`,
        ),
      ).toHaveLength(0);
      expect(
        await as(
          m,
          () => sql`update variants set price_incl_vat_cents = 1 where id = ${b.vid} returning id`,
        ),
      ).toHaveLength(0);
      await denied(() =>
        as(m, () => sql`update products set org_id = ${world.b.orgId} where id = ${own.pid}`),
      );
      await denied(() =>
        as(m, () => sql`update variants set product_id = ${b.pid} where id = ${own.vid}`),
      );
    }));

  it("barcode and SKU are unique per org, not globally", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      await seedProduct(ctx, world.a.orgId, "5012345678900");
      await seedProduct(ctx, world.b.orgId, "5012345678900"); // same barcode in another shop is fine
      const pid = randomUUID();
      await sql`insert into products (id, org_id, name, tax_category) values (${pid}, ${world.a.orgId}, 'Dup', 'ZERO')`;
      await denied(
        () =>
          as(
            world.a.manager,
            () =>
              sql`insert into variants (id, org_id, product_id, price_incl_vat_cents, barcode) values (${randomUUID()}, ${world.a.orgId}, ${pid}, 1, '5012345678900')`,
          ),
        ["23505"],
      );
      // Several variants without a barcode are fine.
      await sql`insert into variants (id, org_id, product_id, price_incl_vat_cents) values (${randomUUID()}, ${world.a.orgId}, ${pid}, 1), (${randomUUID()}, ${world.a.orgId}, ${pid}, 2)`;
    }));

  it("rejects bad data: catering without take-away category, bad barcode, negative price", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const m = world.a.manager;
      await denied(
        () =>
          as(
            m,
            () =>
              sql`insert into products (id, org_id, name, tax_category) values (${randomUUID()}, ${world.a.orgId}, 'Soup', 'CATERING')`,
          ),
        ["23514"],
      );
      await denied(
        () =>
          as(
            m,
            () =>
              sql`insert into products (id, org_id, name, tax_category) values (${randomUUID()}, ${world.a.orgId}, 'X', 'MADE_UP')`,
          ),
        ["23514"],
      );
      const pid = randomUUID();
      await sql`insert into products (id, org_id, name, tax_category) values (${pid}, ${world.a.orgId}, 'Ok', 'ZERO')`;
      for (const [col, val] of [
        ["barcode", "bad barcode!"],
        ["price", "-1"],
        ["attributes", "[]"],
      ] as const) {
        await denied(
          () =>
            as(m, () =>
              col === "barcode"
                ? sql`insert into variants (id, org_id, product_id, price_incl_vat_cents, barcode) values (${randomUUID()}, ${world.a.orgId}, ${pid}, 1, ${val})`
                : col === "price"
                  ? sql`insert into variants (id, org_id, product_id, price_incl_vat_cents) values (${randomUUID()}, ${world.a.orgId}, ${pid}, ${Number(val)})`
                  : sql`insert into variants (id, org_id, product_id, price_incl_vat_cents, attributes) values (${randomUUID()}, ${world.a.orgId}, ${pid}, 1, ${val}::jsonb)`,
            ),
          ["23514"],
        );
      }
    }));
});

describe("save_product", () => {
  it("creates product, variants and opening stock in one call; re-save archives missing variants", () =>
    inWorld(async ({ sql, world, as }) => {
      const p = payload(world.a.orgId, world.a.locationId);
      const [v1, v2] = p.variants as { id: string }[];
      await as(world.a.manager, () => sql`select public.save_product(${sql.json(p as never)})`);
      const levels =
        await sql`select variant_id, on_hand from stock_levels where org_id = ${world.a.orgId}`;
      expect(levels).toHaveLength(1);
      expect(levels[0]).toMatchObject({ variant_id: v1!.id, on_hand: 5 });

      // Edit: drop the second variant, change the first price; opening stock is not re-applied.
      const edit = {
        ...p,
        variants: [{ ...(p.variants[0] as object), price_incl_vat_cents: 1500, opening_stock: 99 }],
      };
      await as(world.a.owner, () => sql`select public.save_product(${sql.json(edit as never)})`);
      const rows =
        await sql`select id, price_incl_vat_cents, barcode, archived_at from variants where org_id = ${world.a.orgId}`;
      const first = rows.find((r) => r.id === v1!.id)!;
      const second = rows.find((r) => r.id === v2!.id)!;
      expect(first.price_incl_vat_cents).toBe(1500);
      expect(second.archived_at).not.toBeNull();
      expect(second.barcode).toBeNull();
      expect(
        (await sql`select on_hand from stock_levels where org_id = ${world.a.orgId}`)[0]!.on_hand,
      ).toBe(5);
    }));

  it("refuses a cashier, an outsider, anon and a duplicate barcode (nothing half-saved)", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const p = payload(world.a.orgId, world.a.locationId);
      const save = (actor: Parameters<typeof as>[0]) =>
        as(actor, () => sql`select public.save_product(${sql.json(p as never)})`);
      await denied(() => save(world.a.cashier));
      await denied(() => save(world.b.owner));
      await denied(() => save(null));

      await seedProduct(ctx, world.a.orgId, "111");
      await denied(() => save(world.a.manager), ["23505"]);
      expect(await sql`select 1 from products where id = ${p.product.id}`).toHaveLength(0);
    }));

  it("cannot take over another shop's product by reusing its id", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const b = await seedProduct(ctx, world.b.orgId);
      const p = payload(world.a.orgId, world.a.locationId);
      p.product.id = b.pid;
      await denied(() =>
        as(world.a.manager, () => sql`select public.save_product(${sql.json(p as never)})`),
      );
      expect((await sql`select name from products where id = ${b.pid}`)[0]!.name).toBe("Tea");
    }));
});

describe("save_product guards", () => {
  it("refuses a missing variants list, a variant id owned by another product, and a bad deposit", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const m = world.a.manager;
      const save = (body: object) =>
        as(m, () => sql`select public.save_product(${sql.json(body as never)})`);

      const own = await seedProduct(ctx, world.a.orgId);
      const p = payload(world.a.orgId, world.a.locationId);
      await denied(() => save({ ...p, variants: undefined }), ["22023", "42501"]);
      await denied(() => save({ ...p, variants: "x" }), ["22023", "42501"]);
      expect(
        (await sql`select archived_at from variants where id = ${own.vid}`)[0]!.archived_at,
      ).toBeNull();

      // A variant id that belongs to another product in the same shop cannot be hijacked.
      p.variants[0]!.id = own.vid;
      await denied(() => save(p), ["42501"]);

      const q = payload(world.a.orgId, world.a.locationId);
      (q.variants[0]!.attributes as Record<string, unknown>) = { depositCents: -500 };
      await denied(() => save(q), ["23514"]);
      (q.variants[0]!.attributes as Record<string, unknown>) = { depositCents: 10001 };
      await denied(() => save(q), ["23514"]);
      (q.variants[0]!.attributes as Record<string, unknown>) = { depositCents: 15 };
      await save(q);
    }));
});
