// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("org helper functions", () => {
  it("a signed-in user with no memberships sees nothing anywhere", () =>
    inWorld(async ({ sql, as }) => {
      const stranger = { userId: randomUUID(), role: "cashier" as const };
      for (const table of ["organisations", "memberships", "locations", "registers", "audit_log"]) {
        const rows = await as(stranger, () => sql.unsafe(`select 1 from ${table}`));
        expect(rows, table).toHaveLength(0);
      }
      const ids = await as(stranger, () => sql`select app.current_org_ids() as id`);
      expect(ids).toHaveLength(0);
    }));

  it("a user in both shops sees both, and loses access when the membership is removed", () =>
    inWorld(async ({ sql, world, as }) => {
      const both = { userId: randomUUID(), role: "manager" as const };
      for (const orgId of [world.a.orgId, world.b.orgId]) {
        await sql`insert into memberships (id, org_id, user_id, role) values (${randomUUID()}, ${orgId}, ${both.userId}, 'manager')`;
      }
      const seen = await as(both, () => sql`select id from organisations`);
      expect(new Set(seen.map((r) => r.id))).toEqual(new Set([world.a.orgId, world.b.orgId]));

      await sql`delete from memberships where user_id = ${both.userId} and org_id = ${world.b.orgId}`;
      const after = await as(both, () => sql`select id from organisations`);
      expect(after.map((r) => r.id)).toEqual([world.a.orgId]);
    }));

  it("role helpers return only orgs where the caller has that role", () =>
    inWorld(async ({ sql, world, as }) => {
      const owned = (a: typeof world.a.owner) => as(a, () => sql`select app.owner_org_ids() as id`);
      const managed = (a: typeof world.a.owner) =>
        as(a, () => sql`select app.manager_org_ids() as id`);
      expect(await owned(world.a.owner)).toHaveLength(1);
      expect(await owned(world.a.manager)).toHaveLength(0);
      expect(await managed(world.a.manager)).toHaveLength(1);
      expect(await managed(world.a.cashier)).toHaveLength(0);
    }));

  it("anon cannot call the helpers", () =>
    inWorld(async ({ sql, as, denied }) => {
      await denied(() => as(null, () => sql`select app.current_org_ids()`));
      await denied(() =>
        as(
          null,
          () => sql`select app.org_ids_with_roles(array['owner']::public.membership_role[])`,
        ),
      );
    }));
});

describe("column and relationship guards", () => {
  it("owner cannot change country or move an organisation's identity", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(() =>
        as(
          world.a.owner,
          () => sql`update organisations set country = 'GB' where id = ${world.a.orgId}`,
        ),
      );
      // profile fields in another org are simply invisible to the update
      const rows = await as(
        world.a.owner,
        () =>
          sql`update organisations set cro_number = 'X' where id = ${world.b.orgId} returning id`,
      );
      expect(rows).toHaveLength(0);
    }));

  it("audit_log cannot be given a client-chosen created_at", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`insert into audit_log (id, org_id, action, entity, created_at) values (${randomUUID()}, ${world.a.orgId}, 'x', 'y', '2000-01-01')`,
        ),
      );
    }));

  it("manager can move a register within the org; a location with registers cannot be deleted", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const second = randomUUID();
      await sql`insert into locations (id, org_id, name) values (${second}, ${world.a.orgId}, 'Second')`;
      const moved = await as(
        world.a.manager,
        () =>
          sql`update registers set location_id = ${second} where id = ${world.a.registerId} returning id`,
      );
      expect(moved).toHaveLength(1);
      const cashierMove = await as(
        world.a.cashier,
        () =>
          sql`update registers set location_id = ${world.a.locationId} where id = ${world.a.registerId} returning id`,
      );
      expect(cashierMove).toHaveLength(0);
      await denied(() => as(world.a.owner, () => sql`delete from locations where id = ${second}`));
    }));

  it("service role can still set the server-only secrets", () =>
    inWorld(async ({ sql, world, asService }) => {
      const pin = await asService(
        () =>
          sql`update memberships set pin_hash = 'argon2-new' where user_id = ${world.a.cashier.userId} returning id`,
      );
      const dev = await asService(
        () =>
          sql`update registers set device_token_hash = 'hash', paired_at = now() where id = ${world.a.registerId} returning id`,
      );
      expect(pin).toHaveLength(1);
      expect(dev).toHaveLength(1);
    }));
});
