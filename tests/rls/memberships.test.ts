// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("memberships RLS", () => {
  it("members see their org's memberships and never Shop B's", () =>
    inWorld(async ({ sql, world, as }) => {
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        const rows = await as(actor, () => sql`select org_id, user_id from memberships`);
        expect(rows).toHaveLength(3);
        expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([world.a.orgId]));
      }
    }));

  it("pin_hash is not readable or writable by clients", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(() => as(world.a.owner, () => sql`select pin_hash from memberships`));
      await denied(() => as(world.a.owner, () => sql`select * from memberships`));
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`update memberships set pin_hash = 'x' where user_id = ${world.a.cashier.userId}`,
        ),
      );
    }));

  it("owner can add, change and remove members in their own org", () =>
    inWorld(async ({ sql, world, as }) => {
      const newUser = randomUUID();
      const ins = await as(
        world.a.owner,
        () =>
          sql`insert into memberships (id, org_id, user_id, role) values (${randomUUID()}, ${world.a.orgId}, ${newUser}, 'cashier') returning id`,
      );
      expect(ins).toHaveLength(1);
      const upd = await as(
        world.a.owner,
        () => sql`update memberships set role = 'manager' where user_id = ${newUser} returning id`,
      );
      expect(upd).toHaveLength(1);
      const del = await as(
        world.a.owner,
        () => sql`delete from memberships where user_id = ${newUser} returning id`,
      );
      expect(del).toHaveLength(1);
    }));

  it("cashier and manager cannot change roles, including their own", () =>
    inWorld(async ({ sql, world, as }) => {
      for (const actor of [world.a.cashier, world.a.manager]) {
        const self = await as(
          actor,
          () =>
            sql`update memberships set role = 'owner' where user_id = ${actor.userId} returning id`,
        );
        expect(self).toHaveLength(0);
        const other = await as(
          actor,
          () =>
            sql`update memberships set role = 'cashier' where user_id = ${world.a.owner.userId} returning id`,
        );
        expect(other).toHaveLength(0);
        const del = await as(
          actor,
          () => sql`delete from memberships where user_id = ${world.a.owner.userId} returning id`,
        );
        expect(del).toHaveLength(0);
      }
      const [row] =
        await sql`select role from memberships where user_id = ${world.a.cashier.userId}`;
      expect(row?.role).toBe("cashier");
    }));

  it("cashier and manager cannot add members", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.cashier, world.a.manager]) {
        await denied(() =>
          as(
            actor,
            () =>
              sql`insert into memberships (id, org_id, user_id, role) values (${randomUUID()}, ${world.a.orgId}, ${randomUUID()}, 'owner')`,
          ),
        );
      }
    }));

  it("Shop A's owner cannot touch Shop B's memberships or move rows across orgs", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const owner = world.a.owner;
      await denied(() =>
        as(
          owner,
          () =>
            sql`insert into memberships (id, org_id, user_id, role) values (${randomUUID()}, ${world.b.orgId}, ${owner.userId}, 'owner')`,
        ),
      );
      expect(
        await as(
          owner,
          () =>
            sql`update memberships set role = 'cashier' where org_id = ${world.b.orgId} returning id`,
        ),
      ).toHaveLength(0);
      expect(
        await as(
          owner,
          () => sql`delete from memberships where org_id = ${world.b.orgId} returning id`,
        ),
      ).toHaveLength(0);
      await denied(() =>
        as(
          owner,
          () =>
            sql`update memberships set org_id = ${world.b.orgId} where user_id = ${world.a.cashier.userId}`,
        ),
      );
      const [{ count } = { count: -1 }] =
        await sql`select count(*)::int as count from memberships where org_id = ${world.b.orgId}`;
      expect(count).toBe(3);
    }));

  it("anon gets nothing", () =>
    inWorld(async ({ sql, as, denied }) => {
      await denied(() => as(null, () => sql`select id from memberships`));
    }));
});
