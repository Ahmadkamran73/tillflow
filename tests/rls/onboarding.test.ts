// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Actor, type Ctx } from "./helpers";

afterAll(() => sql.end());

const cats = (...names: string[]) =>
  names.map((name) => ({ id: randomUUID(), name, colour: "#2F6690" }));

function onboard({ sql, as }: Ctx, actor: Actor, orgId: string, tills = 2) {
  const registers = Array.from({ length: tills }, () => randomUUID());
  return as(
    actor,
    () =>
      sql`select public.complete_onboarding(${orgId}, 'Bean There', 'IE1234567T', 'cafe',
            ${randomUUID()}, ${registers}::uuid[], ${sql.json(cats("Hot drinks", "Food"))}, ${randomUUID()})`,
  );
}

describe("complete_onboarding", () => {
  it("the owner sets up the business once: type, location, tills, categories, audit", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const org = world.a.orgId;
      await onboard(ctx, world.a.owner, org, 3);
      const [o] =
        await sql`select name, vat_number, business_type, onboarded_at from organisations where id = ${org}`;
      expect(o).toMatchObject({
        name: "Bean There",
        vat_number: "IE1234567T",
        business_type: "cafe",
      });
      expect(o!.onboarded_at).not.toBeNull();
      const tills =
        await sql`select name from registers where org_id = ${org} and name like 'Till %' order by name`;
      expect(tills.map((r) => r.name)).toEqual(["Till 1", "Till 1", "Till 2", "Till 3"]); // seed has a Till 1 too
      const names = await sql`select name from categories where org_id = ${org} order by sort`;
      expect(names.map((r) => r.name)).toEqual(["Hot drinks", "Food"]);
      const audit =
        await sql`select action from audit_log where org_id = ${org} and action = 'organisation.onboarded'`;
      expect(audit).toHaveLength(1);

      // A second submit changes nothing.
      await onboard(ctx, world.a.owner, org, 5);
      expect(await sql`select id from registers where org_id = ${org}`).toHaveLength(4);
      expect(
        await sql`select id from audit_log where org_id = ${org} and action = 'organisation.onboarded'`,
      ).toHaveLength(1);
    }));

  it("managers, cashiers, other shops, aal1 owners and anon are refused", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      for (const actor of [world.a.manager, world.a.cashier, world.b.owner]) {
        await denied(() => onboard(ctx, actor, world.a.orgId), ["42501"]);
      }
      await denied(
        () =>
          as(
            world.a.owner,
            () =>
              sql`select public.complete_onboarding(${world.a.orgId}, 'X', null, 'cafe', ${randomUUID()}, ${[randomUUID()]}::uuid[], '[]'::jsonb, ${randomUUID()})`,
            { aal: "aal1" },
          ),
        ["42501"],
      );
      await denied(
        () =>
          as(
            null,
            () =>
              sql`select public.complete_onboarding(${world.a.orgId}, 'X', null, 'cafe', ${randomUUID()}, ${[randomUUID()]}::uuid[], '[]'::jsonb, ${randomUUID()})`,
          ),
        ["42501"],
      );
      const [o] = await sql`select onboarded_at from organisations where id = ${world.a.orgId}`;
      expect(o!.onboarded_at).toBeNull();
    }));

  it("refuses 0 or more than 20 tills", () =>
    inWorld(async (ctx) => {
      await ctx.denied(() => onboard(ctx, ctx.world.a.owner, ctx.world.a.orgId, 0), ["22023"]);
      await ctx.denied(() => onboard(ctx, ctx.world.a.owner, ctx.world.a.orgId, 21), ["22023"]);
    }));

  it("onboarded_at and the internal helper are not reachable by clients", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(() =>
        as(
          world.a.owner,
          () => sql`update organisations set onboarded_at = now() where id = ${world.a.orgId}`,
        ),
      );
      await denied(() =>
        as(
          world.a.owner,
          () => sql`select app.add_starter_categories(${world.a.orgId}, '[]'::jsonb)`,
        ),
      );
    }));
});

describe("set_business_type", () => {
  it("switches the type, keeps existing categories and adds missing starters", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const org = world.a.orgId;
      await onboard(ctx, world.a.owner, org);
      await sql`update categories set colour = '#000000' where org_id = ${org} and name = 'Food'`;
      await as(
        world.a.owner,
        () =>
          sql`select public.set_business_type(${org}, 'restaurant', ${sql.json(cats("Food", "Mains"))}, ${randomUUID()})`,
      );
      const [o] = await sql`select business_type from organisations where id = ${org}`;
      expect(o!.business_type).toBe("restaurant");
      const rows =
        await sql`select name, colour from categories where org_id = ${org} order by sort`;
      expect(rows.map((r) => r.name)).toEqual(["Hot drinks", "Food", "Mains"]);
      expect(rows.find((r) => r.name === "Food")!.colour).toBe("#000000");
      const [audit] =
        await sql`select before, after from audit_log where org_id = ${org} and action = 'organisation.business_type_changed'`;
      expect(audit).toMatchObject({
        before: { business_type: "cafe" },
        after: { business_type: "restaurant" },
      });
    }));

  it("only the owner of that shop can change it, and only through the function", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const call = () =>
        sql`select public.set_business_type(${world.a.orgId}, 'clothing', '[]'::jsonb, ${randomUUID()})`;
      for (const actor of [world.a.manager, world.a.cashier, world.b.owner]) {
        await denied(() => as(actor, call), ["42501"]);
      }
      await denied(() => as(world.a.owner, call, { aal: "aal1" }), ["42501"]);
      await denied(() => as(null, call), ["42501"]);
      // A direct update would skip the audit row.
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`update organisations set business_type = 'clothing' where id = ${world.a.orgId}`,
        ),
      );
      const [o] = await sql`select business_type from organisations where id = ${world.a.orgId}`;
      expect(o!.business_type).toBe("general");
    }));
});

describe("onboarding input hardening", () => {
  it("refuses bad category payloads", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const id = randomUUID();
      const tooMany = Array.from({ length: 41 }, (_, i) => ({ id: randomUUID(), name: `C${i}` }));
      for (const [payload, codes] of [
        [{ name: "x" }, ["22023"]], // not an array
        [tooMany, ["22023"]],
        [[{ name: "No id" }], ["23502"]],
        [[{ id, name: "Bad colour", colour: "red" }], ["23514"]],
      ] as const) {
        await denied(
          () =>
            as(
              world.a.owner,
              () =>
                sql`select public.set_business_type(${world.a.orgId}, 'cafe', ${sql.json(payload as never)}, ${randomUUID()})`,
            ),
          [...codes],
        );
      }
    }));

  it("reusing Shop B's ids fails and leaves Shop B untouched", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(
        () =>
          as(
            world.a.owner,
            () =>
              sql`select public.complete_onboarding(${world.a.orgId}, 'A', null, 'cafe', ${world.b.locationId},
                    ${[world.b.registerId]}::uuid[], '[]'::jsonb, ${randomUUID()})`,
          ),
        ["23505"],
      );
      const [loc] = await sql`select org_id, name from locations where id = ${world.b.locationId}`;
      expect(loc).toMatchObject({ org_id: world.b.orgId, name: "Shop B Main" });
      const [reg] = await sql`select org_id from registers where id = ${world.b.registerId}`;
      expect(reg!.org_id).toBe(world.b.orgId);
    }));

  it("the database refuses a VAT number that is not Irish-shaped", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      await denied(
        () =>
          as(
            world.a.owner,
            () => sql`update organisations set vat_number = 'GB123' where id = ${world.a.orgId}`,
          ),
        ["23514"],
      );
    }));
});
