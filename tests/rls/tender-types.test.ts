// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Ctx } from "./helpers";

afterAll(() => sql.end());

const typesOf = (ctx: Ctx, loc: string) =>
  ctx.sql`select id, method, label, archived_at from tender_types where location_id = ${loc} order by sort`;

describe("tender_types", () => {
  it("every location is seeded with Cash, Card and Voucher", () =>
    inWorld(async (ctx) => {
      const rows = await typesOf(ctx, ctx.world.a.locationId);
      expect(rows.map((r) => r.method)).toEqual(["cash", "card", "voucher"]);
      // A location added later is seeded too.
      const loc = randomUUID();
      await ctx.sql`insert into locations (id, org_id, name) values (${loc}, ${ctx.world.a.orgId}, 'Second')`;
      expect((await typesOf(ctx, loc)).length).toBe(3);
    }));

  it("members read their own shop's types, never another shop's; anon reads nothing", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      for (const who of [a.owner, a.manager, a.cashier]) {
        const own = await ctx.as(who, () => typesOf(ctx, a.locationId));
        expect(own.length).toBe(3);
        expect(await ctx.as(who, () => typesOf(ctx, b.locationId))).toHaveLength(0);
      }
      await ctx.denied(() => ctx.as(null, () => typesOf(ctx, a.locationId)));
    }));

  it("a manager adds, renames and archives a card type; Shop B and a cashier cannot", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = randomUUID();
      await ctx.as(a.manager, async () => {
        await ctx.sql`insert into tender_types (id, org_id, location_id, method, label, sort)
                      values (${id}, ${a.orgId}, ${a.locationId}, 'card', 'Card - AIB terminal', 11)`;
        await ctx.sql`update tender_types set label = 'Card - AIB' where id = ${id}`;
        await ctx.sql`update tender_types set archived_at = now() where id = ${id}`;
      });
      expect((await ctx.sql`select label from tender_types where id = ${id}`)[0]!.label).toBe(
        "Card - AIB",
      );

      await ctx.denied(() =>
        ctx.as(
          a.cashier,
          () => ctx.sql`insert into tender_types (id, org_id, location_id, method, label)
                  values (${randomUUID()}, ${a.orgId}, ${a.locationId}, 'card', 'x')`,
        ),
      );
      // Shop B's manager cannot add to Shop A (RLS), nor point Shop B's type at Shop A's location (FK).
      await ctx.denied(() =>
        ctx.as(
          b.manager,
          () => ctx.sql`insert into tender_types (id, org_id, location_id, method, label)
                  values (${randomUUID()}, ${a.orgId}, ${a.locationId}, 'card', 'x')`,
        ),
      );
      await ctx.denied(() =>
        ctx.as(
          b.manager,
          () => ctx.sql`insert into tender_types (id, org_id, location_id, method, label)
                  values (${randomUUID()}, ${b.orgId}, ${a.locationId}, 'card', 'x')`,
        ),
      );
      // Updates by Shop B reach no rows.
      const r = await ctx.as(
        b.manager,
        () => ctx.sql`update tender_types set label = 'hacked' where id = ${id}`,
      );
      expect(r.count).toBe(0);
    }));

  it("the cash type cannot be archived, duplicated, deleted, or have its method changed", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const cash = (await typesOf(ctx, a.locationId))[0]!;
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () => ctx.sql`update tender_types set archived_at = now() where id = ${cash.id}`,
          ),
        ["23514"],
      );
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () => ctx.sql`insert into tender_types (id, org_id, location_id, method, label)
                    values (${randomUUID()}, ${a.orgId}, ${a.locationId}, 'cash', 'Cash 2')`,
          ),
        ["23505"],
      );
      await ctx.denied(() =>
        ctx.as(
          a.owner,
          () => ctx.sql`update tender_types set method = 'card' where id = ${cash.id}`,
        ),
      );
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`delete from tender_types where id = ${cash.id}`),
      );
    }));

  it("refuses a bad method and an empty or long label", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      for (const [method, label] of [
        ["bitcoin", "x"],
        ["card", "   "],
        ["card", "y".repeat(41)],
      ] as const) {
        await ctx.denied(
          () =>
            ctx.as(
              a.manager,
              () => ctx.sql`insert into tender_types (id, org_id, location_id, method, label)
                      values (${randomUUID()}, ${a.orgId}, ${a.locationId}, ${method}, ${label})`,
            ),
          ["23514"],
        );
      }
    }));
});
