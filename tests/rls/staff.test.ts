// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Actor, type Ctx } from "./helpers";

afterAll(() => sql.end());

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
const HASH2 = "$argon2id$v=19$m=19456,t=2,p=1$b3RoZXJzYWx0$b3RoZXJoYXNo";

const add = async (ctx: Ctx, actor: Actor | null, orgId: string, name: string, hash = HASH) => {
  const membershipId = randomUUID();
  const [row] = await ctx.as(
    actor,
    () =>
      ctx.sql`select public.add_till_staff(${orgId}, ${membershipId}, ${name}, ${hash}, ${randomUUID()}) as user_id`,
  );
  return { membershipId, userId: row!.user_id as string };
};
const setPin = (ctx: Ctx, actor: Actor | null, membershipId: string, hash = HASH2) =>
  ctx.as(
    actor,
    () => ctx.sql`select public.set_member_pin(${membershipId}, ${hash}, ${randomUUID()})`,
  );
const remove = (ctx: Ctx, actor: Actor | null, membershipId: string) =>
  ctx.as(actor, () => ctx.sql`select public.remove_till_staff(${membershipId}, ${randomUUID()})`);
const membershipOf = async (ctx: Ctx, userId: string) =>
  (await ctx.sql`select id from memberships where user_id = ${userId}`)[0]!.id as string;

describe("till-only staff", () => {
  it("a manager or owner adds a cashier by name and PIN; one audit row each, no hash in it", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const aoife = await add(ctx, world.a.manager, world.a.orgId, "Aoife");
      await add(ctx, world.a.owner, world.a.orgId, "Cian");
      const [row] = await sql`select org_id, role, display_name, pin_hash, pin_set_at
        from memberships where id = ${aoife.membershipId}`;
      expect(row).toMatchObject({ org_id: world.a.orgId, role: "cashier", display_name: "Aoife" });
      expect(row!.pin_hash).toBe(HASH);
      const audit = await sql`select actor_user_id, entity_id, after from audit_log
        where org_id = ${world.a.orgId} and action = 'staff.added' order by created_at`;
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        actor_user_id: world.a.manager.userId,
        entity_id: aoife.userId,
        after: { role: "cashier", display_name: "Aoife" },
      });
      expect(JSON.stringify(audit)).not.toContain("argon2");
    }));

  it("cashiers, Shop B and anonymous cannot add staff; bad input and duplicate names are refused", () =>
    inWorld(async (ctx) => {
      const { world, denied } = ctx;
      for (const actor of [world.a.cashier, world.b.owner, world.b.manager, null]) {
        await denied(() => add(ctx, actor, world.a.orgId, "Intruder"));
      }
      const cheap = "$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";
      for (const hash of ["1234", "", cheap]) {
        await denied(() => add(ctx, world.a.manager, world.a.orgId, "Sam", hash), ["22023"]);
      }
      await denied(() => add(ctx, world.a.manager, world.a.orgId, "  "), ["22023"]);
      await denied(() => add(ctx, world.a.manager, world.a.orgId, "x".repeat(41)), ["22023"]);
      await add(ctx, world.a.manager, world.a.orgId, "Aoife");
      await denied(() => add(ctx, world.a.manager, world.a.orgId, "aoife"), ["23505"]);
      // Shop B may use the same name.
      await add(ctx, world.b.manager, world.b.orgId, "Aoife");
    }));

  it("the cashier's user id is made by the database: a caller cannot attach a real account", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const a = await add(ctx, world.a.manager, world.a.orgId, "Aoife");
      const b = await add(ctx, world.a.manager, world.a.orgId, "Brian");
      expect(a.userId).not.toBe(b.userId);
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier, world.b.owner]) {
        expect([a.userId, b.userId]).not.toContain(actor.userId);
      }
      // Nobody in Shop B gained a membership in Shop A.
      const strangers = await sql`select 1 from memberships
        where org_id = ${world.a.orgId}
          and user_id in (${world.b.owner.userId}, ${world.b.manager.userId}, ${world.b.cashier.userId})`;
      expect(strangers).toHaveLength(0);
    }));

  it("a till-only row never gives a signed-in session access, even if its id were a real user's", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      const aoife = await add(ctx, world.a.manager, world.a.orgId, "Aoife");
      // Simulate a collision: Shop B's cashier somehow shares the till-only id.
      await sql`update memberships set user_id = ${world.b.cashier.userId} where id = ${aoife.membershipId}`;
      const orgs = await as(world.b.cashier, () => sql`select id from organisations`);
      expect(orgs).toEqual([{ id: world.b.orgId }]);
      // The back office can read the flag (it decides which rows show Manage).
      const [row] = await as(
        world.a.manager,
        () => sql`select till_only from memberships where id = ${aoife.membershipId}`,
      );
      expect(row).toEqual({ till_only: true });
    }));

  it("clients still cannot insert memberships directly", () =>
    inWorld(async (ctx) => {
      const { world, as, denied } = ctx;
      await denied(() =>
        as(
          world.a.manager,
          () =>
            ctx.sql`insert into memberships (id, org_id, user_id, role) values (${randomUUID()}, ${world.a.orgId}, ${randomUUID()}, 'cashier')`,
        ),
      );
    }));

  it("a manager sets a till-only cashier's PIN and clears the lockout; never a login account's", () =>
    inWorld(async (ctx) => {
      const { sql, world, denied } = ctx;
      const aoife = await add(ctx, world.a.manager, world.a.orgId, "Aoife");
      await sql`update memberships set pin_failed_count = 5, pin_locked_until = now() + interval '15 minutes'
                where id = ${aoife.membershipId}`;
      await setPin(ctx, world.a.manager, aoife.membershipId);
      const [row] = await sql`select pin_hash, pin_failed_count, pin_locked_until
        from memberships where id = ${aoife.membershipId}`;
      expect(row).toEqual({ pin_hash: HASH2, pin_failed_count: 0, pin_locked_until: null });

      // People with a login set their own PIN; nobody sets it for them (a manager may only clear it).
      for (const who of [world.a.cashier, world.a.manager, world.a.owner]) {
        const id = await membershipOf(ctx, who.userId);
        await denied(() => setPin(ctx, world.a.owner, id));
        await denied(() => setPin(ctx, world.a.manager, id));
      }
      await setPin(ctx, world.a.owner, aoife.membershipId);
      for (const actor of [world.a.cashier, world.b.owner, null]) {
        await denied(() => setPin(ctx, actor, aoife.membershipId));
      }
      await denied(() => setPin(ctx, world.a.manager, aoife.membershipId, "1234"), ["22023"]);
    }));

  it("a manager removes a till-only cashier only; past sales keep their cashier id", () =>
    inWorld(async (ctx) => {
      const { sql, world, denied } = ctx;
      const aoife = await add(ctx, world.a.manager, world.a.orgId, "Aoife");
      for (const actor of [world.a.cashier, world.b.manager, null]) {
        await denied(() => remove(ctx, actor, aoife.membershipId));
      }
      for (const who of [world.a.cashier, world.a.manager]) {
        const id = await membershipOf(ctx, who.userId);
        await denied(() => remove(ctx, world.a.owner, id));
        await denied(() => remove(ctx, world.a.manager, id));
      }
      await remove(ctx, world.a.manager, aoife.membershipId);
      expect(await sql`select 1 from memberships where id = ${aoife.membershipId}`).toHaveLength(0);
      const [a] = await sql`select before from audit_log
        where org_id = ${world.a.orgId} and action = 'staff.removed'`;
      expect(a!.before).toEqual({ role: "cashier", display_name: "Aoife" });
    }));

  it("a new cashier reaches the till's staff list and can unlock it", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const aoife = await add(ctx, world.a.manager, world.a.orgId, "Aoife");
      const [meta] = await sql`select ops.device_feed_meta(${world.a.tokenHash}) as m`;
      const staff = (meta!.m as { staff: { user_id: string; display_name: string }[] }).staff;
      expect(staff.find((s) => s.user_id === aoife.userId)?.display_name).toBe("Aoife");
      const [b] =
        await sql`select * from ops.pin_attempt_begin(${world.a.tokenHash}, ${aoife.userId})`;
      expect(b).toMatchObject({ status: "ok", pin_hash: HASH, role: "cashier" });
    }));
});
