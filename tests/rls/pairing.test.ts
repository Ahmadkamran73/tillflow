// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { enrolTotp, inWorld, sql, type Ctx } from "./helpers";

afterAll(() => sql.end());

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const createCode = (ctx: Ctx, actor: Parameters<Ctx["as"]>[0], registerId: string, code: string) =>
  ctx.as(
    actor,
    () =>
      ctx.sql`select public.create_pairing_code(${registerId}, ${sha(code)}, ${randomUUID()}) as expires`,
  );

const pair = async (ctx: Ctx, code: string, token: string) =>
  ctx.sql`select * from ops.pair_register(${sha(code)}, ${sha(token)})`;

const deviceAuth = async (ctx: Ctx, token: string) =>
  ctx.sql`select * from ops.device_auth(${sha(token)})`;

describe("register pairing codes", () => {
  it("a manager or owner gets a code that expires in 10 minutes; a cashier cannot", () =>
    inWorld(async (ctx) => {
      const { sql, world, denied } = ctx;
      for (const actor of [world.a.owner, world.a.manager]) {
        const [row] = await createCode(ctx, actor, world.a.registerId, `CODE-${actor.role}`);
        const ms = new Date(row!.expires as string).getTime() - Date.now();
        expect(ms).toBeGreaterThan(9 * 60_000);
        expect(ms).toBeLessThanOrEqual(10 * 60_000 + 5_000);
      }
      await denied(() => createCode(ctx, world.a.cashier, world.a.registerId, "CASHIER"));
      await denied(() => createCode(ctx, null, world.a.registerId, "ANON"));
      const audit = await sql`select count(*)::int as n from audit_log
        where org_id = ${world.a.orgId} and action = 'register.pairing_code_created'`;
      expect(audit[0]!.n).toBe(2);
    }));

  it("owners who set up a second factor but are at aal1 are refused", () =>
    inWorld(async (ctx) => {
      await enrolTotp(ctx.sql, ctx.world.a.owner);
      await ctx.denied(() =>
        ctx.as(
          ctx.world.a.owner,
          () =>
            ctx.sql`select public.create_pairing_code(${ctx.world.a.registerId}, ${sha("X")}, ${randomUUID()})`,
          { aal: "aal1" },
        ),
      );
    }));

  it("Shop B cannot create a code for Shop A's till, or read its codes", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      await createCode(ctx, world.a.manager, world.a.registerId, "FORA");
      await denied(() => createCode(ctx, world.b.owner, world.a.registerId, "STEAL"));
      await denied(() => createCode(ctx, world.b.manager, world.a.registerId, "STEAL2"));
      for (const actor of [world.b.owner, world.b.manager, world.b.cashier, world.a.cashier]) {
        expect(await as(actor, () => sql`select id from register_pairing_codes`)).toHaveLength(0);
      }
      // A manager sees the row but never the code hash.
      expect(
        await as(world.a.manager, () => sql`select id from register_pairing_codes`),
      ).toHaveLength(1);
      await denied(() =>
        as(world.a.manager, () => sql`select code_hash from register_pairing_codes`),
      );
      await denied(() => as(null, () => sql`select id from register_pairing_codes`));
    }));

  it("clients cannot write the codes table or the pairing fields", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      await denied(() =>
        as(
          world.a.owner,
          () =>
            sql`insert into register_pairing_codes (id, org_id, register_id, code_hash, expires_at, created_by)
                values (${randomUUID()}, ${world.a.orgId}, ${world.a.registerId}, ${sha("x")}, now() + interval '1 day', ${world.a.owner.userId})`,
        ),
      );
      await createCode(ctx, world.a.owner, world.a.registerId, "ONE");
      await denied(() =>
        as(world.a.owner, () => sql`update register_pairing_codes set used_at = null`),
      );
      await denied(() => as(world.a.owner, () => sql`delete from register_pairing_codes`));
    }));
});

describe("ops.pair_register", () => {
  it("exchanges a good code for a token once; the code cannot be reused", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      await createCode(ctx, world.a.manager, world.a.registerId, "GOODCODE");
      const paired = await pair(ctx, "GOODCODE", "token-1");
      expect(paired).toHaveLength(1);
      expect(paired[0]).toMatchObject({ org_id: world.a.orgId, register_id: world.a.registerId });

      const [reg] =
        await sql`select device_token_hash, paired_at from registers where id = ${world.a.registerId}`;
      expect(reg!.device_token_hash).toBe(sha("token-1"));
      expect(reg!.paired_at).not.toBeNull();
      expect(await deviceAuth(ctx, "token-1")).toHaveLength(1);

      // Single use.
      expect(await pair(ctx, "GOODCODE", "token-2")).toHaveLength(0);
      expect(await deviceAuth(ctx, "token-2")).toHaveLength(0);
      const audit = await sql`select count(*)::int as n from audit_log
        where org_id = ${world.a.orgId} and action = 'register.paired'`;
      expect(audit[0]!.n).toBe(1);
    }));

  it("an expired code, an unknown code and a malformed token pair nothing", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      await createCode(ctx, world.a.manager, world.a.registerId, "EXPIRING");
      // Nine minutes in: still good. Eleven: gone.
      await sql`update register_pairing_codes set expires_at = now() + interval '1 minute'`;
      await sql`update register_pairing_codes set expires_at = now() - interval '1 second'`;
      expect(await pair(ctx, "EXPIRING", "late")).toHaveLength(0);
      expect(await pair(ctx, "NEVERMADE", "nope")).toHaveLength(0);
      expect(
        await sql`select * from ops.pair_register(${sha("EXPIRING")}, ${"not-a-sha256"})`,
      ).toHaveLength(0);
      const [reg] =
        await sql`select device_token_hash from registers where id = ${world.a.registerId}`;
      expect(reg!.device_token_hash).toBe(world.a.tokenHash); // untouched
    }));

  it("a new code voids the till's earlier unused codes", () =>
    inWorld(async (ctx) => {
      const { world } = ctx;
      await createCode(ctx, world.a.manager, world.a.registerId, "FIRST");
      await createCode(ctx, world.a.manager, world.a.registerId, "SECOND");
      expect(await pair(ctx, "FIRST", "t1")).toHaveLength(0);
      expect(await pair(ctx, "SECOND", "t2")).toHaveLength(1);
    }));

  it("pairing again replaces the token: the old device stops working", () =>
    inWorld(async (ctx) => {
      const { world } = ctx;
      await createCode(ctx, world.a.manager, world.a.registerId, "ROUND1");
      await pair(ctx, "ROUND1", "old-device");
      expect(await deviceAuth(ctx, "old-device")).toHaveLength(1);
      await createCode(ctx, world.a.manager, world.a.registerId, "ROUND2");
      await pair(ctx, "ROUND2", "new-device");
      expect(await deviceAuth(ctx, "old-device")).toHaveLength(0);
      expect(await deviceAuth(ctx, "new-device")).toHaveLength(1);
    }));

  it("a token belongs to one till only", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      await expect(
        sql.savepoint(
          (s) =>
            s`update registers set device_token_hash = ${world.a.tokenHash} where id = ${world.b.registerId}`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
    }));

  it("the codes and tokens are not callable by clients", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      for (const actor of [world.a.owner, world.a.cashier, null]) {
        await denied(() =>
          as(actor, () => sql`select * from ops.pair_register(${sha("a")}, ${sha("b")})`),
        );
        await denied(() =>
          as(actor, () => sql`select * from ops.device_auth(${world.a.tokenHash})`),
        );
      }
    }));
});

describe("revoking a till", () => {
  it("a manager revokes: the token stops working at once and open codes are voided", () =>
    inWorld(async (ctx) => {
      const { sql, world, as } = ctx;
      await createCode(ctx, world.a.manager, world.a.registerId, "PAIRME");
      await pair(ctx, "PAIRME", "tok");
      await createCode(ctx, world.a.manager, world.a.registerId, "OPENCODE");
      expect(await deviceAuth(ctx, "tok")).toHaveLength(1);

      await as(
        world.a.manager,
        () => sql`select public.revoke_register(${world.a.registerId}, ${randomUUID()})`,
      );
      expect(await deviceAuth(ctx, "tok")).toHaveLength(0);
      expect(await pair(ctx, "OPENCODE", "tok2")).toHaveLength(0);
      const [reg] =
        await sql`select device_token_hash, paired_at from registers where id = ${world.a.registerId}`;
      expect(reg).toEqual({ device_token_hash: null, paired_at: null });
      const audit = await sql`select count(*)::int as n from audit_log
        where org_id = ${world.a.orgId} and action = 'register.revoked' and entity_id = ${world.a.registerId}`;
      expect(audit[0]!.n).toBe(1);
    }));

  it("cashiers, anonymous users and Shop B cannot revoke", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      for (const actor of [world.a.cashier, world.b.owner, world.b.manager, null]) {
        await denied(() =>
          as(
            actor,
            () => sql`select public.revoke_register(${world.a.registerId}, ${randomUUID()})`,
          ),
        );
      }
      expect(await deviceAuth(ctx, "x")).toHaveLength(0);
      const rows = await sql`select 1 from ops.device_auth(${world.a.tokenHash})`;
      expect(rows).toHaveLength(1); // still paired
    }));

  it("a closed organisation's tills are refused", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      expect(await sql`select 1 from ops.device_auth(${world.a.tokenHash})`).toHaveLength(1);
      await sql`update organisations set status = 'closed' where id = ${world.a.orgId}`;
      expect(await sql`select 1 from ops.device_auth(${world.a.tokenHash})`).toHaveLength(0);
    }));
});
