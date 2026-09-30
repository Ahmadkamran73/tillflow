// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("registers RLS", () => {
  it("members see only their own registers, never the device token hash", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        const rows = await as(actor, () => sql`select id from registers`);
        expect(rows.map((r) => r.id)).toEqual([world.a.registerId]);
        await denied(() => as(actor, () => sql`select device_token_hash from registers`));
      }
      await denied(() => as(null, () => sql`select id from registers`));
    }));

  it("owner and manager can manage registers; cashier cannot", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager]) {
        const id = randomUUID();
        const ins = await as(
          actor,
          () =>
            sql`insert into registers (id, org_id, location_id, name) values (${id}, ${world.a.orgId}, ${world.a.locationId}, ${"T " + id}) returning id`,
        );
        expect(ins).toHaveLength(1);
        expect(
          await as(
            actor,
            () => sql`update registers set name = 'Bar' where id = ${id} returning id`,
          ),
        ).toHaveLength(1);
        expect(
          await as(actor, () => sql`delete from registers where id = ${id} returning id`),
        ).toHaveLength(1);
      }
      await denied(() =>
        as(
          world.a.cashier,
          () =>
            sql`insert into registers (id, org_id, location_id, name) values (${randomUUID()}, ${world.a.orgId}, ${world.a.locationId}, 'Nope')`,
        ),
      );
      expect(
        await as(
          world.a.cashier,
          () => sql`update registers set name = 'X' where id = ${world.a.registerId} returning id`,
        ),
      ).toHaveLength(0);
      expect(
        await as(
          world.a.cashier,
          () => sql`delete from registers where id = ${world.a.registerId} returning id`,
        ),
      ).toHaveLength(0);
    }));

  it("pairing fields are server-only", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`update registers set device_token_hash = 'mine' where id = ${world.a.registerId}`,
        ),
      );
      await denied(() =>
        as(
          world.a.owner,
          () => sql`update registers set paired_at = now() where id = ${world.a.registerId}`,
        ),
      );
    }));

  it("Shop A cannot write to Shop B, move a row there, or point at B's location", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        await denied(() =>
          as(
            actor,
            () =>
              sql`insert into registers (id, org_id, location_id, name) values (${randomUUID()}, ${world.b.orgId}, ${world.b.locationId}, 'Sneaky')`,
          ),
        );
        expect(
          await as(
            actor,
            () => sql`update registers set name = 'X' where org_id = ${world.b.orgId} returning id`,
          ),
        ).toHaveLength(0);
        expect(
          await as(
            actor,
            () => sql`delete from registers where org_id = ${world.b.orgId} returning id`,
          ),
        ).toHaveLength(0);
      }
      // Own org_id but Shop B's location: the composite FK refuses it.
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`insert into registers (id, org_id, location_id, name) values (${randomUUID()}, ${world.a.orgId}, ${world.b.locationId}, 'Cross')`,
        ),
      );
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`update registers set location_id = ${world.b.locationId} where id = ${world.a.registerId}`,
        ),
      );
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`update registers set org_id = ${world.b.orgId} where id = ${world.a.registerId}`,
        ),
      );
    }));
});
