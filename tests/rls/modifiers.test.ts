// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { seedGroup, seedProduct } from "./catalog-helpers";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("modifier tables RLS", () => {
  it("members see only their own groups, options and links; anon nothing", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = await seedGroup(ctx, world.a.orgId);
      await seedGroup(ctx, world.b.orgId);
      const p = await seedProduct(ctx, world.a.orgId);
      await sql`insert into product_modifier_groups (id, org_id, product_id, group_id) values (${randomUUID()}, ${world.a.orgId}, ${p.pid}, ${a.gid})`;
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        expect(
          (await as(actor, () => sql`select id from modifier_groups`)).map((r) => r.id),
        ).toEqual([a.gid]);
        expect((await as(actor, () => sql`select id from modifiers`)).map((r) => r.id)).toEqual([
          a.oid,
        ]);
        expect(await as(actor, () => sql`select id from product_modifier_groups`)).toHaveLength(1);
      }
      await denied(() => as(null, () => sql`select id from modifier_groups`));
      await denied(() => as(null, () => sql`select id from modifiers`));
      await denied(() => as(null, () => sql`select id from product_modifier_groups`));
    }));

  it("managers write, cashiers cannot, only the owner deletes a group", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { gid, oid } = await seedGroup(ctx, world.a.orgId);
      const m = world.a.manager;
      expect(
        await as(
          m,
          () => sql`update modifier_groups set max_choices = 3 where id = ${gid} returning id`,
        ),
      ).toHaveLength(1);
      expect(
        await as(
          m,
          () => sql`update modifiers set price_delta_cents = 60 where id = ${oid} returning id`,
        ),
      ).toHaveLength(1);
      expect(
        await as(
          world.a.cashier,
          () => sql`update modifiers set price_delta_cents = 1 where id = ${oid} returning id`,
        ),
      ).toHaveLength(0);
      await denied(() =>
        as(
          world.a.cashier,
          () =>
            sql`insert into modifier_groups (id, org_id, name) values (${randomUUID()}, ${world.a.orgId}, 'X')`,
        ),
      );
      expect(
        await as(m, () => sql`delete from modifier_groups where id = ${gid} returning id`),
      ).toHaveLength(0);
      expect(
        await as(m, () => sql`delete from modifiers where id = ${oid} returning id`),
      ).toHaveLength(1);
      expect(
        await as(
          world.a.owner,
          () => sql`delete from modifier_groups where id = ${gid} returning id`,
        ),
      ).toHaveLength(1);
    }));

  it("cannot cross orgs; checks reject bad choice counts", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const b = await seedGroup(ctx, world.b.orgId);
      const a = await seedGroup(ctx, world.a.orgId, "A milk");
      const pa = await seedProduct(ctx, world.a.orgId);
      const m = world.a.manager;
      await denied(() =>
        as(
          m,
          () =>
            sql`insert into modifier_groups (id, org_id, name) values (${randomUUID()}, ${world.b.orgId}, 'X')`,
        ),
      );
      await denied(() =>
        as(
          m,
          () =>
            sql`insert into modifiers (id, org_id, group_id, name) values (${randomUUID()}, ${world.a.orgId}, ${b.gid}, 'X')`,
        ),
      );
      await denied(() =>
        as(
          m,
          () =>
            sql`insert into product_modifier_groups (id, org_id, product_id, group_id) values (${randomUUID()}, ${world.a.orgId}, ${pa.pid}, ${b.gid})`,
        ),
      );
      expect(
        await as(
          m,
          () => sql`update modifiers set name = 'Hacked' where id = ${b.oid} returning id`,
        ),
      ).toHaveLength(0);
      expect(
        await as(m, () => sql`delete from modifiers where id = ${b.oid} returning id`),
      ).toHaveLength(0);
      await denied(() =>
        as(m, () => sql`update modifier_groups set org_id = ${world.b.orgId} where id = ${a.gid}`),
      );
      await denied(
        () =>
          as(
            m,
            () =>
              sql`insert into modifier_groups (id, org_id, name, min_choices, max_choices) values (${randomUUID()}, ${world.a.orgId}, 'Bad', 3, 1)`,
          ),
        ["23514"],
      );
      await denied(
        () =>
          as(
            m,
            () =>
              sql`insert into modifier_groups (id, org_id, name, max_choices) values (${randomUUID()}, ${world.a.orgId}, 'Big', 21)`,
          ),
        ["23514"],
      );
    }));
});

describe("save_modifier_group", () => {
  const payload = (orgId: string, options: unknown[]) => ({
    org_id: orgId,
    group: { id: randomUUID(), name: "Size", min_choices: 1, max_choices: 1 },
    options,
  });

  it("saves group and options, then replaces and drops options on edit", () =>
    inWorld(async ({ sql, world, as }) => {
      const o1 = randomUUID();
      const o2 = randomUUID();
      const p = payload(world.a.orgId, [
        { id: o1, name: "Small", price_delta_cents: 0 },
        { id: o2, name: "Large", price_delta_cents: 80 },
      ]);
      await as(
        world.a.manager,
        () => sql`select public.save_modifier_group(${sql.json(p as never)})`,
      );
      expect(await sql`select 1 from modifiers where group_id = ${p.group.id}`).toHaveLength(2);

      const edit = { ...p, options: [{ id: o2, name: "Large", price_delta_cents: 100 }] };
      await as(
        world.a.owner,
        () => sql`select public.save_modifier_group(${sql.json(edit as never)})`,
      );
      const rows =
        await sql`select id, price_delta_cents from modifiers where group_id = ${p.group.id}`;
      expect(rows).toEqual([expect.objectContaining({ id: o2, price_delta_cents: 100 })]);
    }));

  it("refuses a cashier, an outsider, and another shop's group id", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const opts = [{ id: randomUUID(), name: "S", price_delta_cents: 0 }];
      const p = payload(world.a.orgId, opts);
      const save = (actor: Parameters<typeof as>[0], body: object) =>
        as(actor, () => sql`select public.save_modifier_group(${sql.json(body as never)})`);
      await denied(() => save(world.a.cashier, p));
      await denied(() => save(world.b.owner, p));
      const b = await seedGroup(ctx, world.b.orgId);
      const steal = payload(world.a.orgId, opts);
      steal.group.id = b.gid;
      await denied(() => save(world.a.manager, steal));
      expect((await sql`select name from modifier_groups where id = ${b.gid}`)[0]!.name).toBe(
        "Milk",
      );
    }));
});
