// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Actor, type Ctx } from "./helpers";

afterAll(() => sql.end());

const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";

const setPin = (ctx: Ctx, actor: Actor | null, orgId: string, name = "Sam", hash = HASH) =>
  ctx.as(
    actor,
    () => ctx.sql`select public.set_my_pin_hash(${orgId}, ${hash}, ${name}, ${randomUUID()})`,
  );

const begin = async (ctx: Ctx, token: string, user: string) =>
  (await ctx.sql`select * from ops.pin_attempt_begin(${token}, ${user})`)[0]!;
const finish = async (ctx: Ctx, token: string, user: string, ok: boolean) =>
  (await ctx.sql`select * from ops.pin_attempt_finish(${token}, ${user}, ${ok})`)[0]!;

describe("setting and resetting PINs", () => {
  it("a member sets their own PIN hash and till name; the audit row holds no hash", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        await setPin(ctx, actor, world.a.orgId, `Name ${actor.role}`);
      }
      const rows = await sql`select user_id, display_name, pin_hash, pin_set_at from memberships
        where org_id = ${world.a.orgId} order by display_name`;
      expect(rows.map((r) => r.display_name)).toEqual([
        "Name cashier",
        "Name manager",
        "Name owner",
      ]);
      expect(rows.every((r) => r.pin_hash === HASH && r.pin_set_at !== null)).toBe(true);
      const audit = await sql`select action, before, after from audit_log
        where org_id = ${world.a.orgId} and action = 'staff.pin_set'`;
      expect(audit).toHaveLength(3);
      expect(JSON.stringify(audit)).not.toContain("argon2");
    }));

  it("refuses anything that is not an Argon2id hash, an empty name, other shops and anonymous", () =>
    inWorld(async (ctx) => {
      const { world, denied } = ctx;
      const cheap = "$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo"; // trivially cheap to crack
      const bad = ["1234", "$2b$10$abcdefghijklmnopqrstuv", "", HASH + "x".repeat(300), cheap];
      for (const hash of bad) {
        await denied(() => setPin(ctx, world.a.cashier, world.a.orgId, "Sam", hash), ["22023"]);
      }
      await denied(() => setPin(ctx, world.a.cashier, world.a.orgId, "  "), ["22023"]);
      await denied(() => setPin(ctx, world.a.cashier, world.a.orgId, "x".repeat(41)), ["22023"]);
      // Not a member of Shop B; no session at all.
      await denied(() => setPin(ctx, world.a.cashier, world.b.orgId));
      await denied(() => setPin(ctx, null, world.a.orgId));
      // An owner without the second factor is not treated as a member.
      await denied(() =>
        ctx.as(
          world.a.owner,
          () =>
            ctx.sql`select public.set_my_pin_hash(${world.a.orgId}, ${HASH}, 'Own', ${randomUUID()})`,
          { aal: "aal1" },
        ),
      );
    }));

  it("PIN hashes and the failure counter are unreadable and unwritable through the API", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier]) {
        await denied(() => as(actor, () => sql`select pin_hash from memberships`));
        await denied(() => as(actor, () => sql`select pin_failed_count from memberships`));
        await denied(() => as(actor, () => sql`update memberships set pin_hash = 'x'`));
        await denied(() => as(actor, () => sql`update memberships set pin_locked_until = null`));
        await denied(() => as(actor, () => sql`update memberships set display_name = 'x'`));
        // Name, "has a PIN" and lock time are fine to see.
        await as(
          actor,
          () => sql`select display_name, pin_set_at, pin_locked_until from memberships`,
        );
      }
    }));

  it("a manager resets a cashier's PIN; only an owner resets a manager or owner", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const mid = async (a: Actor) =>
        (await sql`select id from memberships where user_id = ${a.userId}`)[0]!.id as string;
      const reset = (actor: Actor | null, target: string) =>
        as(actor, () => sql`select public.reset_member_pin(${target}, ${randomUUID()})`);

      await sql`update memberships set pin_failed_count = 5, pin_locked_until = now() + interval '5 minutes'
                where user_id = ${world.a.cashier.userId}`;
      await reset(world.a.manager, await mid(world.a.cashier));
      const [c] = await sql`select pin_hash, pin_set_at, pin_failed_count, pin_locked_until
                            from memberships where user_id = ${world.a.cashier.userId}`;
      expect(c).toEqual({
        pin_hash: null,
        pin_set_at: null,
        pin_failed_count: 0,
        pin_locked_until: null,
      });

      const [ownerId, managerId, cashierId] = [
        await mid(world.a.owner),
        await mid(world.a.manager),
        await mid(world.a.cashier),
      ];
      await denied(() => reset(world.a.manager, ownerId));
      await denied(() => reset(world.a.cashier, managerId));
      await denied(() => reset(world.b.owner, cashierId));
      await denied(() => reset(null, cashierId));
      await reset(world.a.owner, managerId);
      const audit = await sql`select count(*)::int as n from audit_log
        where org_id = ${world.a.orgId} and action = 'staff.pin_reset'`;
      expect(audit[0]!.n).toBe(2);
    }));
});

describe("PIN lockout (5 failures, 15 minutes)", () => {
  it("the fifth failure locks the account and even the right PIN is refused while locked", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const user = world.a.cashier.userId;
      const token = world.a.tokenHash;

      for (let i = 1; i <= 4; i++) {
        expect((await begin(ctx, token, user)).status).toBe("ok");
        expect((await finish(ctx, token, user, false)).locked).toBe(false);
      }
      expect((await begin(ctx, token, user)).status).toBe("ok");
      const last = await finish(ctx, token, user, false);
      expect(last.locked).toBe(true);
      const ms = new Date(last.locked_until as string).getTime() - Date.now();
      expect(ms).toBeGreaterThan(14 * 60_000);
      expect(ms).toBeLessThanOrEqual(15 * 60_000 + 5_000);

      const refused = await begin(ctx, token, user);
      expect(refused.status).toBe("locked");
      expect(refused.pin_hash).toBeNull(); // never hands out the hash while locked
      const audit = await sql`select count(*)::int as n from audit_log
        where org_id = ${world.a.orgId} and action = 'staff.pin_locked' and entity_id = ${user}`;
      expect(audit[0]!.n).toBe(1);
    }));

  it("attempts are reserved before the PIN is checked: ten in a row allow exactly five", () =>
    inWorld(async (ctx) => {
      const { world } = ctx;
      const statuses: string[] = [];
      for (let i = 0; i < 10; i++) {
        statuses.push((await begin(ctx, world.a.tokenHash, world.a.cashier.userId)).status);
      }
      expect(statuses.filter((s) => s === "ok")).toHaveLength(5);
      expect(statuses.slice(5).every((s) => s === "locked")).toBe(true);
    }));

  it("a good PIN resets the count; a lock that has run out starts a fresh count", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const user = world.a.cashier.userId;
      const token = world.a.tokenHash;
      for (let i = 0; i < 3; i++) {
        await begin(ctx, token, user);
        await finish(ctx, token, user, false);
      }
      await begin(ctx, token, user);
      await finish(ctx, token, user, true);
      const [m] = await sql`select pin_failed_count from memberships where user_id = ${user}`;
      expect(m!.pin_failed_count).toBe(0);

      await sql`update memberships set pin_failed_count = 5, pin_locked_until = now() - interval '1 second'
                where user_id = ${user}`;
      expect((await begin(ctx, token, user)).status).toBe("ok");
      const [after] =
        await sql`select pin_failed_count, pin_locked_until from memberships where user_id = ${user}`;
      expect(after).toEqual({ pin_failed_count: 1, pin_locked_until: null });
    }));

  it("the lock is per person: a locked cashier does not lock the manager", () =>
    inWorld(async (ctx) => {
      const { world } = ctx;
      for (let i = 0; i < 6; i++) await begin(ctx, world.a.tokenHash, world.a.cashier.userId);
      expect((await begin(ctx, world.a.tokenHash, world.a.cashier.userId)).status).toBe("locked");
      expect((await begin(ctx, world.a.tokenHash, world.a.manager.userId)).status).toBe("ok");
    }));

  it("a PIN never works on an unpaired or revoked device, or for another shop's staff", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      await expect(
        sql.savepoint(
          (s) =>
            s`select * from ops.pin_attempt_begin(${"0".repeat(64)}, ${world.a.cashier.userId})`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // Shop A's till asking about Shop B's cashier: not a member there, so no PIN to check.
      expect((await begin(ctx, world.a.tokenHash, world.b.cashier.userId)).status).toBe("no_pin");
      // Someone without a PIN set.
      await sql`update memberships set pin_hash = null where user_id = ${world.a.cashier.userId}`;
      expect((await begin(ctx, world.a.tokenHash, world.a.cashier.userId)).status).toBe("no_pin");

      await as(
        world.a.manager,
        () => sql`select public.revoke_register(${world.a.registerId}, ${randomUUID()})`,
      );
      await expect(
        sql.savepoint(
          (s) =>
            s`select * from ops.pin_attempt_begin(${world.a.tokenHash}, ${world.a.manager.userId})`,
        ),
      ).rejects.toMatchObject({ code: "42501" });
    }));

  it("clients cannot call the attempt functions", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      for (const actor of [world.a.owner, world.a.cashier, null]) {
        await denied(() =>
          as(
            actor,
            () =>
              sql`select * from ops.pin_attempt_begin(${world.a.tokenHash}, ${world.a.cashier.userId})`,
          ),
        );
        await denied(() =>
          as(
            actor,
            () =>
              sql`select * from ops.pin_attempt_finish(${world.a.tokenHash}, ${world.a.cashier.userId}, true)`,
          ),
        );
      }
    }));
});

describe("device feed", () => {
  it("hands a till its own shop's staff (with PIN hashes) and nothing of Shop B's", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const [row] = await sql`select ops.device_feed_meta(${world.a.tokenHash}) as m`;
      const meta = row!.m as {
        staff: { user_id: string }[];
        register: { id: string };
        org: { discount_override_bp: number };
      };
      expect(meta.register.id).toBe(world.a.registerId);
      expect(meta.org.discount_override_bp).toBe(1000);
      expect(meta.staff.map((s) => s.user_id).sort()).toEqual(
        [world.a.owner, world.a.manager, world.a.cashier].map((a) => a.userId).sort(),
      );
      const [none] = await sql`select ops.device_feed_meta(${"f".repeat(64)}) as m`;
      expect(none!.m).toBeNull();
      const [tbl] =
        await sql`select ops.device_feed_table(${"f".repeat(64)}, 'products', null, null, 10) as t`;
      expect(tbl!.t).toBeNull();
    }));
});

describe("discount override threshold", () => {
  it("only an owner (verified) changes it, within 0..100%, and it is audited with before and after", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      const set = (actor: Actor | null, bp: number, session = {}) =>
        as(
          actor,
          () => sql`select public.set_discount_override(${world.a.orgId}, ${bp}, ${randomUUID()})`,
          session,
        );
      await set(world.a.owner, 500);
      const [o] =
        await sql`select discount_override_bp from organisations where id = ${world.a.orgId}`;
      expect(o!.discount_override_bp).toBe(500);
      const [a] = await sql`select before, after from audit_log
        where org_id = ${world.a.orgId} and action = 'organisation.discount_override_changed'`;
      expect(a).toEqual({ before: { bp: 1000 }, after: { bp: 500 } });

      await denied(() => set(world.a.manager, 500));
      await denied(() => set(world.a.cashier, 500));
      await denied(() => set(world.b.owner, 500));
      await denied(() => set(null, 500));
      await denied(() => set(world.a.owner, 500, { aal: "aal1" }));
      await denied(() => set(world.a.owner, -1), ["22023"]);
      await denied(() => set(world.a.owner, 10001), ["22023"]);
      // Not writable directly either.
      await denied(() =>
        as(
          world.a.owner,
          () => sql`update organisations set discount_override_bp = 0 where id = ${world.a.orgId}`,
        ),
      );
    }));
});
