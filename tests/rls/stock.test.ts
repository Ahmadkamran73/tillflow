// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("stock_movements / stock_levels RLS", () => {
  it("managers record opening/adjustment stock as themselves; levels follow the ledger", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { vid } = await seedProduct(ctx, world.a.orgId);
      const m = world.a.manager;
      const insert = (
        qty: number,
        reason: string,
        actor = m.userId,
        org = world.a.orgId,
        loc = world.a.locationId,
      ) =>
        as(
          m,
          () => sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, actor_user_id)
                        values (${randomUUID()}, ${org}, ${vid}, ${loc}, ${qty}, ${reason}, ${actor}) returning id`,
        );
      expect(await insert(10, "opening")).toHaveLength(1);
      expect(await insert(-3, "adjustment")).toHaveLength(1);
      expect(
        (await sql`select on_hand from stock_levels where variant_id = ${vid}`)[0]!.on_hand,
      ).toBe(7);

      await denied(() => insert(1, "sale")); // sales and refunds come from the sync route only
      await denied(() => insert(1, "refund"));
      await denied(() => insert(1, "adjustment", world.a.owner.userId)); // not as someone else
      await denied(() => insert(0, "adjustment"), ["23514"]);
      await denied(() => insert(1, "adjustment", m.userId, world.b.orgId)); // another org
      await denied(() => insert(1, "adjustment", m.userId, world.a.orgId, world.b.locationId)); // another location
    }));

  it("is append-only, cashiers cannot write, levels are read-only, orgs are isolated", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      const b = await seedProduct(ctx, world.b.orgId);
      const mid = randomUUID();
      await sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason) values (${mid}, ${world.a.orgId}, ${a.vid}, ${world.a.locationId}, 4, 'opening')`;
      await sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason) values (${randomUUID()}, ${world.b.orgId}, ${b.vid}, ${world.b.locationId}, 9, 'opening')`;

      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        expect(
          (await as(actor, () => sql`select id from stock_movements`)).map((r) => r.id),
        ).toEqual([mid]);
        expect(await as(actor, () => sql`select on_hand from stock_levels`)).toHaveLength(1);
        await denied(() =>
          as(actor, () => sql`update stock_movements set qty_delta = 100 where id = ${mid}`),
        );
        await denied(() => as(actor, () => sql`delete from stock_movements where id = ${mid}`));
        await denied(() => as(actor, () => sql`update stock_levels set on_hand = 100`));
        await denied(() => as(actor, () => sql`delete from stock_levels`));
        await denied(() =>
          as(
            actor,
            () =>
              sql`insert into stock_levels (id, org_id, variant_id, location_id, on_hand) values (${randomUUID()}, ${world.a.orgId}, ${a.vid}, ${world.a.locationId}, 1)`,
          ),
        );
      }
      await denied(() =>
        as(
          world.a.cashier,
          () =>
            sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, actor_user_id) values (${randomUUID()}, ${world.a.orgId}, ${a.vid}, ${world.a.locationId}, 1, 'adjustment', ${world.a.cashier.userId})`,
        ),
      );
      await denied(() => as(null, () => sql`select id from stock_movements`));
      await denied(() => as(null, () => sql`select id from stock_levels`));
    }));
});
