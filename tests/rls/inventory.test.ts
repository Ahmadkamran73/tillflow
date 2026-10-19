// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("inventory: adjust_stock and low_stock_threshold", () => {
  it("received, damage, count and adjustment go through the ledger; levels follow", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { vid } = await seedProduct(ctx, world.a.orgId);
      const m = world.a.manager;
      const adjust = (reason: string, qty: number, note: string | null = null) =>
        as(
          m,
          () =>
            sql`select public.adjust_stock(${world.a.orgId}, ${vid}, ${world.a.locationId}, ${reason}, ${qty}, ${note}) as d`,
        );
      const onHand = async () =>
        (await sql`select on_hand from stock_levels where variant_id = ${vid}`)[0]?.on_hand;

      expect((await adjust("received", 10, "delivery"))[0]!.d).toBe(10);
      expect((await adjust("damage", 3, "dropped"))[0]!.d).toBe(-3);
      expect(await onHand()).toBe(7);
      // A count of 5 when 7 are on the system records -2; a count of 12 records +5.
      expect((await adjust("count", 5))[0]!.d).toBe(-2);
      expect((await adjust("count", 12))[0]!.d).toBe(7);
      expect((await adjust("adjustment", -20))[0]!.d).toBe(-20);
      expect(await onHand()).toBe(-8); // negative stock is allowed

      const rows =
        await sql`select reason, qty_delta, note, actor_user_id from stock_movements where variant_id = ${vid} order by created_at, qty_delta`;
      expect(rows).toHaveLength(5);
      expect(rows.every((r) => r.actor_user_id === m.userId)).toBe(true);
      expect(rows.find((r) => r.note === "delivery")?.reason).toBe("received");

      await denied(() => adjust("count", -8), ["22023"]);
    }));

  it("a count equal to the system is refused; bad reasons and quantities too", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const { vid } = await seedProduct(ctx, world.a.orgId);
      const m = world.a.manager;
      const adjust = (reason: string, qty: number, note: string | null = null) =>
        as(
          m,
          () =>
            sql`select public.adjust_stock(${world.a.orgId}, ${vid}, ${world.a.locationId}, ${reason}, ${qty}, ${note})`,
        );
      await adjust("received", 4);
      await denied(() => adjust("count", 4), ["22023"]);
      await denied(() => adjust("sale", 1), ["22023"]);
      await denied(() => adjust("refund", 1), ["22023"]);
      await denied(() => adjust("opening", 1), ["22023"]);
      await denied(() => adjust("damage", 0), ["22023"]);
      await denied(() => adjust("received", -1), ["22023"]);
      await denied(() => adjust("adjustment", 0), ["22023"]);
      await denied(() => adjust("received", 1, "x".repeat(201)), ["22023"]);
    }));

  it("cashiers, other shops and anon cannot adjust; an untracked product is refused", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      const call = (actor: typeof world.a.manager | null, org: string, vid: string, loc: string) =>
        as(
          actor,
          () => sql`select public.adjust_stock(${org}, ${vid}, ${loc}, 'received', 1, null)`,
        );
      await denied(() => call(world.a.cashier, world.a.orgId, a.vid, world.a.locationId));
      await denied(() => call(world.b.owner, world.a.orgId, a.vid, world.a.locationId), ["22023"]);
      await denied(() => call(world.b.owner, world.b.orgId, a.vid, world.b.locationId), ["22023"]);
      await denied(() => call(world.a.manager, world.a.orgId, a.vid, world.b.locationId));
      await denied(() => call(null, world.a.orgId, a.vid, world.a.locationId));

      for (const reason of ["count", "received", "damage"]) {
        await denied(() =>
          as(
            world.a.cashier,
            () =>
              sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason, actor_user_id) values (gen_random_uuid(), ${world.a.orgId}, ${a.vid}, ${world.a.locationId}, 1, ${reason}, ${world.a.cashier.userId})`,
          ),
        );
      }
      await sql`update products set track_stock = false where id = ${a.pid}`;
      await denied(
        () => call(world.a.manager, world.a.orgId, a.vid, world.a.locationId),
        ["22023"],
      );
    }));

  it("low_stock_threshold: managers set it within range; cashiers and other shops cannot", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const a = await seedProduct(ctx, world.a.orgId);
      const set = (actor: typeof world.a.manager, v: number | null) =>
        as(
          actor,
          () =>
            sql`update products set low_stock_threshold = ${v} where id = ${a.pid} returning id`,
        );
      expect(await set(world.a.manager, 5)).toHaveLength(1);
      expect(
        (await sql`select low_stock_threshold from products where id = ${a.pid}`)[0]!
          .low_stock_threshold,
      ).toBe(5);
      expect(await set(world.a.manager, null)).toHaveLength(1);
      await denied(() => set(world.a.manager, -1), ["23514"]);
      await denied(() => set(world.a.manager, 2_000_000), ["23514"]);
      expect(await set(world.a.cashier, 9)).toHaveLength(0); // RLS hides the row from the update
      expect(await set(world.b.owner, 9)).toHaveLength(0);
    }));
});
