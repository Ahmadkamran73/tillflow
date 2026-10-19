// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";
import { payload } from "./catalog-helpers";

afterAll(() => sql.end());

// Cost prices must stay away from cashiers: variants is readable by every member, so cost lives
// in variant_costs (managers and owners only) and is written by save_product.
describe("variant_costs", () => {
  it("the cost column is gone from variants", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(() => as(world.a.owner, () => sql`select cost_cents from variants`), ["42703"]);
    }));

  it("save_product stores, changes and clears a cost; only managers and owners read it", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const p = payload(world.a.orgId, world.a.locationId);
      const [m, l] = p.variants;
      (m as Record<string, unknown>).cost_cents = 800;
      await as(world.a.manager, () => sql`select public.save_product(${sql.json(p as never)})`);

      for (const actor of [world.a.owner, world.a.manager]) {
        const rows = await as(actor, () => sql`select variant_id, cost_cents from variant_costs`);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ variant_id: m!.id, cost_cents: 800 });
      }
      expect(await as(world.a.cashier, () => sql`select 1 from variant_costs`)).toHaveLength(0);
      await denied(() => as(null, () => sql`select 1 from variant_costs`));
      // Shop B sees none of shop A's costs.
      expect(await as(world.b.owner, () => sql`select 1 from variant_costs`)).toHaveLength(0);

      // Change one, add one, then clear the first.
      (m as Record<string, unknown>).cost_cents = 900;
      (l as Record<string, unknown>).cost_cents = 100;
      await as(world.a.owner, () => sql`select public.save_product(${sql.json(p as never)})`);
      const after = await as(
        world.a.owner,
        () => sql`select variant_id, cost_cents from variant_costs order by cost_cents`,
      );
      expect(after.map((r) => r.cost_cents)).toEqual([100, 900]);
      (m as Record<string, unknown>).cost_cents = null;
      await as(world.a.owner, () => sql`select public.save_product(${sql.json(p as never)})`);
      expect(
        (await as(world.a.owner, () => sql`select cost_cents from variant_costs`)).map(
          (r) => r.cost_cents,
        ),
      ).toEqual([100]);
    }));

  it("update and delete reach nothing for a cashier or another shop; a removed variant drops its cost", () =>
    inWorld(async ({ sql, world, as }) => {
      const p = payload(world.a.orgId, world.a.locationId);
      (p.variants[0] as Record<string, unknown>).cost_cents = 800;
      await as(world.a.manager, () => sql`select public.save_product(${sql.json(p as never)})`);
      const vid = p.variants[0]!.id;
      for (const actor of [world.a.cashier, world.b.owner]) {
        expect(
          await as(
            actor,
            () =>
              sql`update variant_costs set cost_cents = 0 where variant_id = ${vid} returning 1`,
          ),
        ).toHaveLength(0);
        expect(
          await as(
            actor,
            () => sql`delete from variant_costs where variant_id = ${vid} returning 1`,
          ),
        ).toHaveLength(0);
      }
      expect(
        await as(
          world.a.owner,
          () => sql`select cost_cents from variant_costs where variant_id = ${vid}`,
        ),
      ).toEqual([{ cost_cents: 800 }]);

      // Saving the product without that variant archives it and drops its cost.
      p.variants = [p.variants[1]!];
      await as(world.a.owner, () => sql`select public.save_product(${sql.json(p as never)})`);
      expect(
        await as(world.a.owner, () => sql`select 1 from variant_costs where variant_id = ${vid}`),
      ).toHaveLength(0);
    }));

  it("a cashier cannot write costs; nobody writes another shop's", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const p = payload(world.a.orgId, world.a.locationId);
      await as(world.a.manager, () => sql`select public.save_product(${sql.json(p as never)})`);
      const vid = p.variants[0]!.id;
      await denied(() =>
        as(
          world.a.cashier,
          () =>
            sql`insert into variant_costs (variant_id, org_id, cost_cents) values (${vid}, ${world.a.orgId}, 1)`,
        ),
      );
      await denied(() =>
        as(
          world.b.owner,
          () =>
            sql`insert into variant_costs (variant_id, org_id, cost_cents) values (${vid}, ${world.b.orgId}, 1)`,
        ),
      );
      await denied(() =>
        as(
          world.b.owner,
          () =>
            sql`insert into variant_costs (variant_id, org_id, cost_cents) values (${vid}, ${world.a.orgId}, 1)`,
        ),
      );
      await denied(
        () =>
          as(
            world.a.manager,
            () =>
              sql`insert into variant_costs (variant_id, org_id, cost_cents) values (${vid}, ${world.a.orgId}, -5)`,
          ),
        ["23514"], // the range check
      );
    }));
});
