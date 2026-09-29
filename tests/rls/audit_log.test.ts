// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("audit_log RLS and append-only", () => {
  it("owner and manager read their org's log only; cashier and anon read nothing", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager]) {
        const rows = await as(actor, () => sql`select org_id from audit_log`);
        expect(rows.length).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.org_id))).toEqual(new Set([world.a.orgId]));
      }
      expect(await as(world.a.cashier, () => sql`select id from audit_log`)).toHaveLength(0);
      await denied(() => as(null, () => sql`select id from audit_log`));
    }));

  it("members can append entries in their own org as themselves, nothing else", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const insert = (actor: typeof world.a.owner, orgId: string, actorId: string) =>
        as(
          actor,
          () =>
            sql`insert into audit_log (id, org_id, actor_user_id, action, entity) values (${randomUUID()}, ${orgId}, ${actorId}, 'refund.override', 'sale')`,
        );
      await insert(world.a.cashier, world.a.orgId, world.a.cashier.userId);
      await denied(() => insert(world.a.cashier, world.b.orgId, world.a.cashier.userId));
      await denied(() => insert(world.a.cashier, world.a.orgId, world.a.owner.userId));
      await denied(() =>
        as(
          null,
          () =>
            sql`insert into audit_log (id, org_id, action, entity) values (${randomUUID()}, ${world.a.orgId}, 'x', 'y')`,
        ),
      );
    }));

  it("nobody can update, delete or truncate it", () =>
    inWorld(async ({ sql, world, as, asService, denied }) => {
      const update = () => sql`update audit_log set action = 'tampered'`;
      const del = () => sql`delete from audit_log`;
      const truncate = () => sql.unsafe("truncate audit_log");
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier, world.b.owner, null]) {
        await denied(() => as(actor, update));
        await denied(() => as(actor, del));
        await denied(() => as(actor, truncate));
      }
      await denied(() => asService(update));
      await denied(() => asService(del));
      await denied(() => asService(truncate));
      // Even the table owner (migration/seed role) is stopped by the trigger.
      await denied(update);
      await denied(del);
      await denied(truncate);
      const [{ count } = { count: -1 }] =
        await sql`select count(*)::int as count from audit_log where action = 'tampered'`;
      expect(count).toBe(0);
    }));

  it("Shop A cannot read Shop B's log", () =>
    inWorld(async ({ sql, world, as }) => {
      const rows = await as(
        world.a.owner,
        () => sql`select id from audit_log where org_id = ${world.b.orgId}`,
      );
      expect(rows).toHaveLength(0);
    }));
});
