// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("organisations RLS", () => {
  it("members see only their own org; anon sees nothing", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        const rows = await as(actor, () => sql`select id from organisations`).catch(() => null);
        expect(rows?.map((r) => r.id)).toEqual([world.a.orgId]);
      }
      await denied(() => as(null, () => sql`select id from organisations`));
    }));

  it("only the owner can edit profile fields, and only in their own org", () =>
    inWorld(async ({ sql, world, as }) => {
      const upd = (actor: typeof world.a.owner, orgId: string) =>
        as(
          actor,
          () => sql`update organisations set name = 'Renamed' where id = ${orgId} returning id`,
        );
      expect(await upd(world.a.owner, world.a.orgId)).toHaveLength(1);
      expect(await upd(world.a.manager, world.a.orgId)).toHaveLength(0);
      expect(await upd(world.a.cashier, world.a.orgId)).toHaveLength(0);
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        expect(await upd(actor, world.b.orgId)).toHaveLength(0);
      }
      const [b] = await sql`select name from organisations where id = ${world.b.orgId}`;
      expect(b?.name).toBe("Shop B");
    }));

  it("owner cannot change billing fields or the id", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const id = world.a.orgId;
      await denied(() =>
        as(world.a.owner, () => sql`update organisations set plan = 'free' where id = ${id}`),
      );
      await denied(() =>
        as(world.a.owner, () => sql`update organisations set status = 'active' where id = ${id}`),
      );
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`update organisations set trial_ends_at = now() + interval '5 years' where id = ${id}`,
        ),
      );
      await denied(() =>
        as(
          world.a.owner,
          () => sql`update organisations set id = ${randomUUID()} where id = ${id}`,
        ),
      );
    }));

  it("nobody can insert or delete organisations through the API", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier, null]) {
        await denied(() =>
          as(
            actor,
            () =>
              sql`insert into organisations (id, name, business_type) values (${randomUUID()}, 'X', 'cafe')`,
          ),
        );
        await denied(() =>
          as(actor, () => sql`delete from organisations where id = ${world.b.orgId}`),
        );
      }
    }));
});
