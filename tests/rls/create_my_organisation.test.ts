// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Actor } from "./helpers";

afterAll(() => sql.end());

const newcomer = (): Actor => ({ userId: randomUUID(), role: "owner" });
const UNIQUE_VIOLATION = ["23505"];
const INVALID_PARAM = ["22023"];

describe("public.create_my_organisation (sign-up provisioning)", () => {
  it("creates the org, an owner membership and an audit row for the caller only", () =>
    inWorld(async ({ sql, world, as }) => {
      const me = newcomer();
      const orgId = randomUUID();
      const [row] = await as(
        me,
        () =>
          sql`select public.create_my_organisation(${orgId}, ${randomUUID()}, ${randomUUID()}, ' Corner Shop ') as id`,
      );
      expect(row?.id).toBe(orgId);

      const orgs = await as(me, () => sql`select id, name, status from organisations`);
      expect(orgs).toEqual([{ id: orgId, name: "Corner Shop", status: "trial" }]);
      const members = await as(me, () => sql`select user_id, role from memberships`);
      expect(members).toEqual([{ user_id: me.userId, role: "owner" }]);
      const audit = await as(me, () => sql`select action, actor_user_id from audit_log`);
      expect(audit).toEqual([{ action: "organisation.created", actor_user_id: me.userId }]);

      // Shop A and Shop B cannot see the new org.
      for (const other of [world.a.owner, world.b.owner]) {
        const seen = await as(other, () => sql`select id from organisations where id = ${orgId}`);
        expect(seen).toHaveLength(0);
      }
    }));

  it("is idempotent: a second call returns the same org and creates nothing", () =>
    inWorld(async ({ sql, as }) => {
      const me = newcomer();
      const first = randomUUID();
      await as(
        me,
        () =>
          sql`select public.create_my_organisation(${first}, ${randomUUID()}, ${randomUUID()}, 'One')`,
      );
      const [again] = await as(
        me,
        () =>
          sql`select public.create_my_organisation(${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'Two') as id`,
      );
      expect(again?.id).toBe(first);
      const orgs = await as(me, () => sql`select name from organisations`);
      expect(orgs).toEqual([{ name: "One" }]);
    }));

  it("an existing member gets their own org back, never a new one or someone else's", () =>
    inWorld(async ({ sql, world, as }) => {
      const [row] = await as(
        world.a.cashier,
        () =>
          sql`select public.create_my_organisation(${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'Sneaky') as id`,
      );
      expect(row?.id).toBe(world.a.orgId);
      const count = await sql`select count(*)::int as n from organisations where name = 'Sneaky'`;
      expect(count[0]?.n).toBe(0);
    }));

  it("cannot overwrite or attach to an existing org by reusing its id", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(
        () =>
          as(
            newcomer(),
            () =>
              sql`select public.create_my_organisation(${world.b.orgId}, ${randomUUID()}, ${randomUUID()}, 'Takeover')`,
          ),
        UNIQUE_VIOLATION,
      );
      const members =
        await sql`select count(*)::int as n from memberships where org_id = ${world.b.orgId}`;
      expect(members[0]?.n).toBe(3);
    }));

  it("refuses anonymous callers and invalid names", () =>
    inWorld(async ({ sql, as, denied }) => {
      await denied(() =>
        as(
          null,
          () =>
            sql`select public.create_my_organisation(${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'Anon')`,
        ),
      );
      for (const name of ["", "   ", "x".repeat(121)]) {
        await denied(
          () =>
            as(
              newcomer(),
              () =>
                sql`select public.create_my_organisation(${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${name})`,
            ),
          INVALID_PARAM,
        );
      }
    }));
});
