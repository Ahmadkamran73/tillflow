// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("locations RLS", () => {
  it("members see only their own locations; anon sees nothing", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        const rows = await as(actor, () => sql`select id from locations`);
        expect(rows.map((r) => r.id)).toEqual([world.a.locationId]);
      }
      await denied(() => as(null, () => sql`select id from locations`));
    }));

  it("owner and manager can create and edit; cashier cannot", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager]) {
        const id = randomUUID();
        const ins = await as(
          actor,
          () =>
            sql`insert into locations (id, org_id, name) values (${id}, ${world.a.orgId}, ${"L " + id}) returning id`,
        );
        expect(ins).toHaveLength(1);
        const upd = await as(
          actor,
          () => sql`update locations set eircode = 'D02 X285' where id = ${id} returning id`,
        );
        expect(upd).toHaveLength(1);
      }
      await denied(() =>
        as(
          world.a.cashier,
          () =>
            sql`insert into locations (id, org_id, name) values (${randomUUID()}, ${world.a.orgId}, 'Nope')`,
        ),
      );
      const upd = await as(
        world.a.cashier,
        () =>
          sql`update locations set name = 'Hacked' where id = ${world.a.locationId} returning id`,
      );
      expect(upd).toHaveLength(0);
    }));

  it("only the owner can delete a location", () =>
    inWorld(async ({ sql, world, as }) => {
      const id = randomUUID();
      await sql`insert into locations (id, org_id, name) values (${id}, ${world.a.orgId}, 'Temp')`;
      for (const actor of [world.a.cashier, world.a.manager]) {
        expect(
          await as(actor, () => sql`delete from locations where id = ${id} returning id`),
        ).toHaveLength(0);
      }
      expect(
        await as(world.a.owner, () => sql`delete from locations where id = ${id} returning id`),
      ).toHaveLength(1);
    }));

  it("Shop A cannot write to Shop B or move a row there", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        await denied(() =>
          as(
            actor,
            () =>
              sql`insert into locations (id, org_id, name) values (${randomUUID()}, ${world.b.orgId}, 'Sneaky')`,
          ),
        );
        expect(
          await as(
            actor,
            () => sql`update locations set name = 'X' where org_id = ${world.b.orgId} returning id`,
          ),
        ).toHaveLength(0);
        expect(
          await as(
            actor,
            () => sql`delete from locations where org_id = ${world.b.orgId} returning id`,
          ),
        ).toHaveLength(0);
      }
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`update locations set org_id = ${world.b.orgId} where id = ${world.a.locationId}`,
        ),
      );
      const [row] = await sql`select name from locations where id = ${world.b.locationId}`;
      expect(row?.name).toBe("Shop B Main");
    }));
});
