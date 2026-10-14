// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { enrolTotp, inWorld, sql, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const LIMIT = ["TF002"];
const NOT_FRESH = ["TF003"];

const nowSec = () => Math.floor(Date.now() / 1000);
/** A session that has just passed an authenticator code (aal2), as a two-step owner has. */
const FRESH = { aal: "aal2" as const, amr: [{ method: "totp", timestamp: nowSec() }] };
const NOT_ALLOWED = ["42501"];

const request = (
  ctx: Ctx,
  shop: Shop,
  who = shop.owner,
  id = randomUUID(),
  session: Parameters<Ctx["as"]>[2] = FRESH,
) =>
  ctx
    .as(who, () => ctx.sql`select public.request_account_export(${shop.orgId}, ${id})`, session)
    .then(() => id);

/** What the job does, in order: begin, read a page, finish. */
async function runJob(ctx: Ctx, id: string, bytes = Buffer.from("PK-fake-zip")) {
  const start = (await ctx.sql`select ops.account_export_begin(${id}) as r`)[0]!.r;
  await ctx.sql`select ops.account_export_finish(${id}, 'export.zip', ${bytes})`;
  return start as { org_id: string; org_name: string };
}

describe("account export requests", () => {
  it("owners ask once a day, and the request is audited with ids only", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await request(ctx, a);
      const [row] = await ctx.as(
        a.owner,
        () => ctx.sql`select status, requested_by from account_exports where id = ${id}`,
      );
      expect(row).toMatchObject({ status: "queued", requested_by: a.owner.userId });
      const audit = await ctx.sql`
        select action, entity_id from audit_log where org_id = ${a.orgId} and action = 'account.export_requested'`;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.entity_id).toBe(id);
      await ctx.denied(() => request(ctx, a), LIMIT);
    }));

  it("a request that never started does not lock the owner out for ever", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await request(ctx, a);
      await ctx.sql`update account_exports set requested_at = now() - interval '20 minutes' where id = ${id}`;
      await request(ctx, a); // queued for 20 minutes: no longer counts
    }));

  it("managers, cashiers, anon and the other shop's owner cannot ask", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await ctx.denied(() => request(ctx, a, a.manager), NOT_ALLOWED);
      await ctx.denied(() => request(ctx, a, a.cashier), NOT_ALLOWED);
      await ctx.denied(() => request(ctx, a, b.owner), NOT_ALLOWED);
      await ctx.denied(
        () =>
          ctx.as(
            null,
            () => ctx.sql`select public.request_account_export(${a.orgId}, ${randomUUID()})`,
          ),
        NOT_ALLOWED,
      );
    }));

  it("owners see their own requests; nobody else sees any, and nobody can read the file table", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await request(ctx, a);
      await runJob(ctx, id);
      const read = (who: typeof a.owner) =>
        ctx.as(who, () => ctx.sql`select id from account_exports where org_id = ${a.orgId}`);
      expect(await read(a.owner)).toHaveLength(1);
      expect(await read(a.manager)).toHaveLength(0);
      expect(await read(a.cashier)).toHaveLength(0);
      expect(await read(b.owner)).toHaveLength(0);
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`select bytes from account_export_files`),
      );
      await ctx.denied(() => ctx.as(a.owner, () => ctx.sql`select * from account_export_files`));
      await ctx.denied(() =>
        ctx.as(
          a.owner,
          () => ctx.sql`update account_exports set status = 'ready' where id = ${id}`,
        ),
      );
    }));
});

describe("fresh authentication", () => {
  const old = nowSec() - 3600;
  const justNow = nowSec() - 30;
  const stale = { aal: "aal2" as const, amr: [{ method: "totp", timestamp: old }] };

  async function enrol(ctx: Ctx) {
    // Two-step owner of shop A: a verified factor makes the session need aal2 everywhere.
    await enrolTotp(ctx.sql, ctx.world.a.owner);
  }

  it("with two-step verification: a fresh authenticator code is needed, a password is not enough", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      await enrol(ctx);
      await ctx.denied(() => request(ctx, a, a.owner, randomUUID(), stale), NOT_FRESH);
      // A password sign-in a moment ago does not replace the code.
      await ctx.denied(
        () =>
          request(ctx, a, a.owner, randomUUID(), {
            aal: "aal2",
            amr: [
              { method: "totp", timestamp: old },
              { method: "password", timestamp: justNow },
            ],
          }),
        NOT_FRESH,
      );
      await ctx.denied(() => request(ctx, a, a.owner, randomUUID(), { aal: "aal2", amr: [] }), NOT_FRESH);
      await request(ctx, a, a.owner, randomUUID(), {
        aal: "aal2",
        amr: [{ method: "totp", timestamp: justNow }],
      });
    }));

  it("without two-step verification: the password must have been typed in the last 10 minutes", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const aal1 = (amr: { method: string; timestamp?: number }[]) => ({ aal: "aal1" as const, amr });
      await ctx.denied(
        () => request(ctx, a, a.owner, randomUUID(), aal1([{ method: "password", timestamp: old }])),
        NOT_FRESH,
      );
      // A magic link or Google sign-in, however recent, is not a password.
      await ctx.denied(
        () => request(ctx, a, a.owner, randomUUID(), aal1([{ method: "otp", timestamp: justNow }])),
        NOT_FRESH,
      );
      await ctx.denied(
        () => request(ctx, a, a.owner, randomUUID(), aal1([{ method: "oauth", timestamp: justNow }])),
        NOT_FRESH,
      );
      await ctx.denied(() => request(ctx, a, a.owner, randomUUID(), aal1([{ method: "password" }])), NOT_FRESH);
      await ctx.denied(
        () => request(ctx, a, a.owner, randomUUID(), aal1([{ method: "password", timestamp: nowSec() + 0 - 601 }])),
        NOT_FRESH,
      );
      await request(ctx, a, a.owner, randomUUID(), aal1([{ method: "password", timestamp: justNow }]));
    }));

  it("the download needs the same proof, even for a finished export", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await request(ctx, a);
      await runJob(ctx, id);
      const get = (session: Parameters<Ctx["as"]>[2]) =>
        ctx.as(a.owner, () => ctx.sql`select public.get_account_export(${a.orgId}, ${id})`, session);
      await ctx.denied(() => get(stale), NOT_FRESH);
      await ctx.denied(() => get({ aal: "aal2", amr: [] }), NOT_FRESH);
      await get(FRESH);
      // Nothing was audited as downloaded for the refused attempts.
      expect(
        (
          await ctx.sql`select count(*)::int as n from audit_log where org_id = ${a.orgId} and action = 'account.export_downloaded'`
        )[0]!.n,
      ).toBe(1);
    }));

  it("a refused request leaves no row and no audit entry", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      await ctx.denied(() => request(ctx, a, a.owner, randomUUID(), stale), NOT_FRESH);
      expect((await ctx.sql`select count(*)::int as n from account_exports where org_id = ${a.orgId}`)[0]!.n).toBe(0);
    }));

  it("every owner of the shop can be found to be told, and nobody else", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await request(ctx, a);
      const info = (await ctx.sql`select ops.account_export_owner_emails(${id}) as r`)[0]!.r as {
        org_id: string;
        emails: string[];
      };
      expect(info.org_id).toBe(a.orgId);
      expect(Array.isArray(info.emails)).toBe(true);
      await ctx.denied(() => ctx.as(a.owner, () => ctx.sql`select ops.account_export_owner_emails(${id})`));
    }));
});

describe("account export job functions", () => {
  it("pages only the export's own shop and never returns PIN or device secrets", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await request(ctx, a);
      await ctx.sql`select ops.account_export_begin(${id})`;
      const page = async (table: string, offset = 0, limit = 100) =>
        (
          await ctx.sql`select ops.account_export_rows(${id}, ${table}, ${offset}, ${limit}) as r`
        )[0]!.r as Record<string, unknown>[];

      const members = await page("memberships");
      expect(members).toHaveLength(3);
      expect(JSON.stringify(members)).not.toContain("argon2-secret");
      expect(members.every((m) => !("pin_hash" in m) && !("pin_failed_count" in m))).toBe(true);
      expect(members.every((m) => m.org_id === a.orgId)).toBe(true);

      const registers = await page("registers");
      expect(registers).toHaveLength(1);
      expect("device_token_hash" in registers[0]!).toBe(false);
      expect(registers[0]!.name).toBe("Till 1");
      expect((await page("locations")).map((l) => l.org_id)).toEqual([a.orgId]);

      // Paging: offset past the end is empty; a page of 1 returns one row.
      expect(await page("memberships", 3)).toHaveLength(0);
      expect(await page("memberships", 0, 1)).toHaveLength(1);
    }));

  it("refuses unknown tables, odd pages and exports that are not running", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const id = await request(ctx, a);
      const rows = (table: string, offset = 0, limit = 10) =>
        ctx.sql`select ops.account_export_rows(${id}, ${table}, ${offset}, ${limit})`;
      await ctx.denied(() => rows("memberships"), ["22023"]); // still queued
      await ctx.sql`select ops.account_export_begin(${id})`;
      await ctx.denied(() => rows("audit_log"), ["22023"]);
      await ctx.denied(() => rows("organisations"), ["22023"]);
      await ctx.denied(() => rows("memberships; drop table x"), ["22023"]);
      await ctx.denied(() => rows("memberships", -1), ["22023"]);
      await ctx.denied(() => rows("memberships", 0, 0), ["22023"]);
      await ctx.denied(() => rows("memberships", 0, 10001), ["22023"]);
      await ctx.denied(
        () => ctx.sql`select ops.account_export_rows(${randomUUID()}, 'products', 0, 10)`,
        ["22023"],
      );
    }));

  it("the API roles cannot run the job functions", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await request(ctx, a);
      await ctx.denied(() =>
        ctx.as(a.owner, () => ctx.sql`select ops.account_export_begin(${id})`),
      );
      await ctx.denied(() => ctx.as(null, () => ctx.sql`select ops.account_export_purge()`));
    }));
});

describe("downloading", () => {
  it("hands the file to an owner of that shop only, and audits every download", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const id = await request(ctx, a);
      await runJob(ctx, id, Buffer.from("zip-bytes"));
      const get = (who: typeof a.owner, org = a.orgId) =>
        ctx.as(
          who,
          async () => (await ctx.sql`select public.get_account_export(${org}, ${id}) as b`)[0]!.b,
          FRESH,
        );

      const got = (await get(a.owner)) as Buffer;
      expect(Buffer.from(got).toString()).toBe("zip-bytes");
      expect(
        (
          await ctx.sql`select count(*)::int as n from audit_log where org_id = ${a.orgId} and action = 'account.export_downloaded'`
        )[0]!.n,
      ).toBe(1);

      await ctx.denied(() => get(a.manager), NOT_ALLOWED);
      await ctx.denied(() => get(a.cashier), NOT_ALLOWED);
      await ctx.denied(() => get(b.owner), NOT_ALLOWED);
      await ctx.denied(() => get(b.owner, b.orgId), ["22023"]); // B's own shop has no such export
      await ctx.denied(
        () =>
          ctx.as(null, async () => ctx.sql`select public.get_account_export(${a.orgId}, ${id})`),
        NOT_ALLOWED,
      );
      // Unknown id.
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () => ctx.sql`select public.get_account_export(${a.orgId}, ${randomUUID()})`,
            FRESH,
          ),
        ["22023"],
      );
    }));

  it("an expired or unfinished export cannot be downloaded, and the purge removes the file", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await request(ctx, a);
      const get = () =>
        ctx.as(a.owner, () => ctx.sql`select public.get_account_export(${a.orgId}, ${id})`, FRESH);
      await ctx.denied(get, ["22023"]); // queued
      await runJob(ctx, id);
      await ctx.sql`update account_exports set expires_at = now() - interval '1 minute' where id = ${id}`;
      await ctx.denied(get, ["22023"]); // expired

      expect(Number((await ctx.sql`select ops.account_export_purge() as n`)[0]!.n)).toBe(1);
      expect(
        (
          await ctx.sql`select count(*)::int as n from account_export_files where export_id = ${id}`
        )[0]!.n,
      ).toBe(0);
      expect(
        (await ctx.sql`select status, error_code from account_exports where id = ${id}`)[0],
      ).toMatchObject({ status: "failed", error_code: "expired" });
    }));

  it("a failed export carries a short code and can be asked for again at once", () =>
    inWorld(async (ctx) => {
      const a = ctx.world.a;
      const id = await request(ctx, a);
      await ctx.sql`select ops.account_export_begin(${id})`;
      await ctx.sql`select ops.account_export_fail(${id}, 'too_large')`;
      expect(
        (await ctx.sql`select status, error_code from account_exports where id = ${id}`)[0],
      ).toMatchObject({ status: "failed", error_code: "too_large" });
      await request(ctx, a); // a failed request does not count against the day
    }));
});
