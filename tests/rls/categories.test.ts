// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Ctx } from "./helpers";

afterAll(() => sql.end());

async function seedCategory({ sql }: Ctx, orgId: string, name = "Drinks") {
  const id = randomUUID();
  await sql`insert into categories (id, org_id, name) values (${id}, ${orgId}, ${name})`;
  return id;
}

describe("categories RLS", () => {
  it("members see only their own categories; anon sees nothing", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = await seedCategory(ctx, world.a.orgId);
      await seedCategory(ctx, world.b.orgId);
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        const rows = await as(actor, () => sql`select id from categories`);
        expect(rows.map((r) => r.id)).toEqual([a]);
      }
      await denied(() => as(null, () => sql`select id from categories`));
    }));

  it("owner and manager manage categories; cashier cannot; only the owner deletes", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager]) {
        const id = randomUUID();
        expect(
          await as(
            actor,
            () =>
              sql`insert into categories (id, org_id, name) values (${id}, ${world.a.orgId}, ${"C " + id}) returning id`,
          ),
        ).toHaveLength(1);
        expect(
          await as(
            actor,
            () => sql`update categories set colour = '#123456' where id = ${id} returning id`,
          ),
        ).toHaveLength(1);
      }
      const id = randomUUID();
      await sql`insert into categories (id, org_id, name) values (${id}, ${world.a.orgId}, 'Bin')`;
      expect(
        await as(world.a.manager, () => sql`delete from categories where id = ${id} returning id`),
      ).toHaveLength(0);
      expect(
        await as(world.a.owner, () => sql`delete from categories where id = ${id} returning id`),
      ).toHaveLength(1);
      await denied(() =>
        as(
          world.a.cashier,
          () =>
            sql`insert into categories (id, org_id, name) values (${randomUUID()}, ${world.a.orgId}, 'Nope')`,
        ),
      );
    }));

  it("Shop A cannot write to Shop B, move a row there, or parent under B's category", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = await seedCategory(ctx, world.a.orgId);
      const b = await seedCategory(ctx, world.b.orgId);
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        await denied(() =>
          as(
            actor,
            () =>
              sql`insert into categories (id, org_id, name) values (${randomUUID()}, ${world.b.orgId}, 'Sneaky')`,
          ),
        );
        expect(
          await as(actor, () => sql`update categories set name = 'X' where id = ${b} returning id`),
        ).toHaveLength(0);
        expect(
          await as(actor, () => sql`delete from categories where id = ${b} returning id`),
        ).toHaveLength(0);
      }
      await denied(() =>
        as(
          world.a.owner,
          () => sql`update categories set org_id = ${world.b.orgId} where id = ${a}`,
        ),
      );
      // Own org_id but Shop B's parent: the composite FK refuses it.
      await denied(() =>
        as(world.a.owner, () => sql`update categories set parent_id = ${b} where id = ${a}`),
      );
    }));
});
