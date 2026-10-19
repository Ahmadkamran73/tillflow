// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql, type Actor, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const NOT_ALLOWED = ["42501"];
const BAD_VALUE = ["22023"];
const AAL2 = { aal: "aal2" as const };
const AAL1 = { aal: "aal1" as const };

async function makeAdmin(ctx: Ctx): Promise<Actor> {
  const admin: Actor = { userId: randomUUID(), role: "owner" };
  await ctx.sql`insert into platform_admins (user_id) values (${admin.userId})`;
  return admin;
}

async function subscription(ctx: Ctx, shop: Shop, status = "trial") {
  await ctx.sql`insert into subscriptions (id, org_id, status, price_cents)
                values (${randomUUID()}, ${shop.orgId}, ${status}, 4900)`;
}

const audit = async (ctx: Ctx, orgId: string, action: string) =>
  (
    await ctx.sql`select count(*)::int as n from audit_log where org_id = ${orgId} and action = ${action}`
  )[0]!.n as number;

/** Every superadmin function, with arguments that would succeed for a real admin. */
function calls(ctx: Ctx, orgId: string): [string, () => Promise<unknown>][] {
  return [
    ["list", async () => ctx.sql`select public.admin_list_orgs('', 10, 0)`],
    ["name", async () => ctx.sql`select public.admin_org_name(${orgId})`],
    ["usage", async () => ctx.sql`select public.admin_org_usage(${orgId})`],
    ["extend", async () => ctx.sql`select public.admin_extend_trial(${orgId}, 7, 'asked nicely')`],
    ["pause", async () => ctx.sql`select public.admin_pause(${orgId}, 'unpaid by phone')`],
    ["dashboard", async () => ctx.sql`select public.admin_view_dashboard(${orgId})`],
    ["sales", async () => ctx.sql`select public.admin_view_sales(${orgId}, 10, null)`],
    ["products", async () => ctx.sql`select public.admin_view_products(${orgId}, 10, 0)`],
    ["staff", async () => ctx.sql`select public.admin_view_staff(${orgId})`],
    ["shifts", async () => ctx.sql`select public.admin_view_shifts(${orgId}, 10)`],
  ];
}

describe("nobody but the superadmin on a two-step session can call anything", () => {
  it("owner, manager, cashier, another shop's owner, an aal1 admin and anon get 42501 from every function", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      const admin = await makeAdmin(ctx);
      for (const [name, call] of calls(ctx, a.orgId)) {
        const who: [string, Actor | null, { aal: "aal1" | "aal2" }][] = [
          ["owner", a.owner, AAL2],
          ["manager", a.manager, AAL2],
          ["cashier", a.cashier, AAL2],
          ["other shop owner", b.owner, AAL2],
          ["admin at aal1", admin, AAL1],
        ];
        for (const [label, actor, session] of who) {
          await ctx
            .denied(() => ctx.as(actor, call, session), NOT_ALLOWED)
            .catch((e) => {
              throw new Error(`${name} as ${label}: ${(e as Error).message}`);
            });
        }
        await ctx.denied(() => ctx.as(null, call), NOT_ALLOWED);
      }
      // Nothing changed behind the refusals.
      const [o] =
        await ctx.sql`select status, trial_ends_at from organisations where id = ${a.orgId}`;
      expect(o!.status).not.toBe("read_only");
      expect(await audit(ctx, a.orgId, "superadmin.paused")).toBe(0);
      expect(await audit(ctx, a.orgId, "superadmin.viewed")).toBe(0);
    }));

  it("a business owner cannot make themselves a superadmin, read the admin list or write platform_admins", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await ctx.denied(
        () =>
          ctx.as(
            a.owner,
            () => ctx.sql`insert into platform_admins (user_id) values (${a.owner.userId})`,
            AAL2,
          ),
        NOT_ALLOWED,
      );
      await ctx.denied(
        () => ctx.as(a.owner, () => ctx.sql`select * from platform_admins`, AAL2),
        NOT_ALLOWED,
      );
      const [r] = await ctx.as(
        a.owner,
        () => ctx.sql`select public.am_i_platform_admin() as r`,
        AAL2,
      );
      expect(r!.r).toBe(false);
    }));
});

describe("superadmin audit rows are not visible to the business", () => {
  it("an owner and a manager read the business's own audit rows but never superadmin.* ones", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const admin = await makeAdmin(ctx);
      await ctx.as(admin, () => ctx.sql`select public.admin_org_usage(${a.orgId})`, AAL2);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_pause(${a.orgId}, 'unpaid by phone')`,
        AAL2,
      );
      expect(await audit(ctx, a.orgId, "superadmin.paused")).toBe(1);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_unpause(${a.orgId}, 'paid by phone', 7)`,
        AAL2,
      );
      expect(await audit(ctx, a.orgId, "billing.unpaused")).toBe(1); // written, but hidden below
      for (const who of [a.owner, a.manager]) {
        const rows = await ctx.as(
          who,
          () => ctx.sql`select action from audit_log where org_id = ${a.orgId}`,
          AAL2,
        );
        expect(rows.length).toBeGreaterThan(0); // the seeded row is still visible
        expect(
          rows.filter(
            (r) => String(r.action).startsWith("superadmin.") || r.action === "billing.unpaused",
          ),
        ).toHaveLength(0);
      }
    }));
});

describe("what a superadmin reads", () => {
  it("lists businesses with billing status, trial end, last payment and last sync, and filters by name", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await ctx.sql`update organisations set name = 'Zebra Superadmin Probe', trial_ends_at = '2099-01-01' where id = ${a.orgId}`;
      await ctx.sql`update registers set last_seen_at = '2026-10-01T10:00:00Z' where id = ${a.registerId}`;
      const admin = await makeAdmin(ctx);
      const list = async (search: string) =>
        (
          await ctx.as(
            admin,
            () => ctx.sql`select public.admin_list_orgs(${search}, 100, 0) as l`,
            AAL2,
          )
        )[0]!.l as Record<string, unknown>[];
      const hit = (await list("zebra superadmin")).find((o) => o.id === a.orgId);
      expect(hit).toBeDefined();
      expect(Object.keys(hit!).sort()).toEqual(
        [
          "billing_status",
          "created_at",
          "id",
          "last_payment_at",
          "last_sync_at",
          "name",
          "org_status",
          "tills",
          "trial_ends_at",
        ].sort(),
      );
      expect(hit!.billing_status).toBe("trial");
      expect(hit!.last_payment_at).toBeNull();
      expect(new Date(hit!.last_sync_at as string).toISOString()).toBe("2026-10-01T10:00:00.000Z");
      expect(hit!.tills).toBe(1);
      expect((await list("zebra superadmin")).find((o) => o.id === b.orgId)).toBeUndefined();
      // LIKE wildcards in the search are text, not patterns.
      expect((await list("%")).find((o) => o.id === a.orgId)).toBeUndefined();
      await ctx.denied(
        () => ctx.as(admin, () => ctx.sql`select public.admin_list_orgs('', 101, 0)`, AAL2),
        BAD_VALUE,
      );
      await ctx.denied(
        () => ctx.as(admin, () => ctx.sql`select public.admin_list_orgs('', 10, -1)`, AAL2),
        BAD_VALUE,
      );
    }));

  it("usage is counts and dates only, and is audited against that business", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const admin = await makeAdmin(ctx);
      const [row] = await ctx.as(
        admin,
        () => ctx.sql`select public.admin_org_usage(${a.orgId}) as u`,
        AAL2,
      );
      const u = row!.u as Record<string, unknown>;
      expect(u.staff).toBe(3);
      expect(u.tills).toBe(1);
      expect(u.sales_30d).toBe(0);
      const text = JSON.stringify(u);
      expect(text).not.toContain("argon2-secret");
      expect(text).not.toContain("@");
      expect(await audit(ctx, a.orgId, "superadmin.viewed")).toBe(1);
      await ctx.denied(
        () => ctx.as(admin, () => ctx.sql`select public.admin_org_usage(${randomUUID()})`, AAL2),
        BAD_VALUE,
      );
    }));

  it("the staff view shows names, roles and kind only: no pin hash, user id or lockout data", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const admin = await makeAdmin(ctx);
      const [row] = await ctx.as(
        admin,
        () => ctx.sql`select public.admin_view_staff(${a.orgId}) as s`,
        AAL2,
      );
      const staff = row!.s as Record<string, unknown>[];
      expect(staff).toHaveLength(3);
      for (const m of staff)
        expect(Object.keys(m).sort()).toEqual(["display_name", "role", "till_only"]);
      expect(JSON.stringify(staff)).not.toContain("argon2-secret");
      expect(JSON.stringify(staff)).not.toContain(a.owner.userId);
    }));

  it("every view function audits one superadmin.viewed row per call, against the viewed business only", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      const admin = await makeAdmin(ctx);
      const views = calls(ctx, a.orgId).filter(([n]) =>
        ["dashboard", "sales", "products", "staff", "shifts"].includes(n),
      );
      for (const [, call] of views) await ctx.as(admin, call, AAL2);
      expect(await audit(ctx, a.orgId, "superadmin.viewed")).toBe(views.length);
      expect(await audit(ctx, b.orgId, "superadmin.viewed")).toBe(0);
      const [row] = await ctx.sql`select actor_user_id from audit_log
                                  where org_id = ${a.orgId} and action = 'superadmin.viewed' limit 1`;
      expect(row!.actor_user_id).toBe(admin.userId);
    }));

  it("view paging is bounded", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const admin = await makeAdmin(ctx);
      for (const call of [
        () => ctx.sql`select public.admin_view_sales(${a.orgId}, 101, null)`,
        () => ctx.sql`select public.admin_view_sales(${a.orgId}, 0, null)`,
        () => ctx.sql`select public.admin_view_products(${a.orgId}, 101, 0)`,
        () => ctx.sql`select public.admin_view_shifts(${a.orgId}, 101)`,
      ]) {
        await ctx.denied(() => ctx.as(admin, call, AAL2), BAD_VALUE);
      }
    }));
});

describe("what a superadmin changes", () => {
  it("extends only a trial, adds days to the later of the end and now, and audits old and new", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await subscription(ctx, b, "active");
      await ctx.sql`update organisations set status = 'active' where id = ${b.orgId}`;
      await ctx.sql`update organisations set trial_ends_at = '2099-01-01T00:00:00Z' where id = ${a.orgId}`;
      const admin = await makeAdmin(ctx);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_extend_trial(${a.orgId}, 10, 'asked for more time')`,
        AAL2,
      );
      const [o] = await ctx.sql`select trial_ends_at from organisations where id = ${a.orgId}`;
      expect(new Date(o!.trial_ends_at as Date).toISOString()).toBe("2099-01-11T00:00:00.000Z");
      expect(await audit(ctx, a.orgId, "superadmin.trial_extended")).toBe(1);
      const [log] = await ctx.sql`select before, after from audit_log
                                  where org_id = ${a.orgId} and action = 'superadmin.trial_extended'`;
      expect(log!.after).toMatchObject({ days: 10, note: "asked for more time" });
      // An expired trial restarts from now, not from the past.
      await ctx.sql`update organisations set trial_ends_at = '2020-01-01T00:00:00Z' where id = ${a.orgId}`;
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_extend_trial(${a.orgId}, 1, 'one more day')`,
        AAL2,
      );
      const [o2] =
        await ctx.sql`select (trial_ends_at > now()) as future from organisations where id = ${a.orgId}`;
      expect(o2!.future).toBe(true);
      // Not on a trial, bad days, short note, unknown business.
      for (const call of [
        () => ctx.sql`select public.admin_extend_trial(${b.orgId}, 7, 'not a trial any more')`,
        () => ctx.sql`select public.admin_extend_trial(${a.orgId}, 0, 'zero days')`,
        () => ctx.sql`select public.admin_extend_trial(${a.orgId}, 91, 'too many days')`,
        () => ctx.sql`select public.admin_extend_trial(${a.orgId}, 7, 'no')`,
        () => ctx.sql`select public.admin_extend_trial(${randomUUID()}, 7, 'no such business')`,
      ]) {
        await ctx.denied(() => ctx.as(admin, call, AAL2), BAD_VALUE);
      }
      expect(await audit(ctx, b.orgId, "superadmin.trial_extended")).toBe(0);
    }));

  it("extends a trial the billing job has not given an end date yet, counting from now", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const admin = await makeAdmin(ctx);
      const [o] = await ctx.sql`select trial_ends_at from organisations where id = ${a.orgId}`;
      expect(o!.trial_ends_at).toBeNull();
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_extend_trial(${a.orgId}, 5, 'new shop, more time')`,
        AAL2,
      );
      const [r] = await ctx.sql`select (trial_ends_at > now() + interval '4 days 23 hours') as ok
                                from organisations where id = ${a.orgId}`;
      expect(r!.ok).toBe(true);
    }));

  it("pauses once, needs a note, and unpause reopens it; both are audited", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      await subscription(ctx, a);
      const admin = await makeAdmin(ctx);
      await ctx.denied(
        () => ctx.as(admin, () => ctx.sql`select public.admin_pause(${a.orgId}, 'no')`, AAL2),
        BAD_VALUE,
      );
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_pause(${a.orgId}, 'asked to stop billing')`,
        AAL2,
      );
      const [o] =
        await ctx.sql`select o.status as org, s.status as sub, s.paused_at is not null as paused
                                  from organisations o join subscriptions s on s.org_id = o.id where o.id = ${a.orgId}`;
      expect(o).toMatchObject({ org: "read_only", sub: "paused", paused: true });
      // Already paused: refused, and not audited twice.
      await ctx.denied(
        () =>
          ctx.as(admin, () => ctx.sql`select public.admin_pause(${a.orgId}, 'again please')`, AAL2),
        BAD_VALUE,
      );
      expect(await audit(ctx, a.orgId, "superadmin.paused")).toBe(1);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_unpause(${a.orgId}, 'sorted it out', 7)`,
        AAL2,
      );
      const [o2] = await ctx.sql`select status from organisations where id = ${a.orgId}`;
      expect(o2!.status).toBe("active");
      expect(await audit(ctx, a.orgId, "billing.unpaused")).toBe(1);
    }));

  it("a paused business cannot be extended, and a closed one cannot be paused", () =>
    inWorld(async (ctx) => {
      const { a, b } = ctx.world;
      await subscription(ctx, a);
      await subscription(ctx, b);
      await ctx.sql`update organisations set status = 'closed' where id = ${b.orgId}`;
      const admin = await makeAdmin(ctx);
      await ctx.as(
        admin,
        () => ctx.sql`select public.admin_pause(${a.orgId}, 'unpaid by phone')`,
        AAL2,
      );
      await ctx.denied(
        () =>
          ctx.as(
            admin,
            () => ctx.sql`select public.admin_extend_trial(${a.orgId}, 7, 'extend while paused')`,
            AAL2,
          ),
        BAD_VALUE,
      );
      await ctx.denied(
        () =>
          ctx.as(
            admin,
            () => ctx.sql`select public.admin_pause(${b.orgId}, 'close then pause')`,
            AAL2,
          ),
        BAD_VALUE,
      );
    }));

  it("a superadmin has no direct write access to business tables", () =>
    inWorld(async (ctx) => {
      const { a } = ctx.world;
      const admin = await makeAdmin(ctx);
      // The admin is not a member of any shop, so RLS shows and changes nothing.
      const rows = await ctx.as(
        admin,
        () => ctx.sql`select id from products where org_id = ${a.orgId}`,
        AAL2,
      );
      expect(rows).toHaveLength(0);
      const changed = await ctx
        .as(
          admin,
          () =>
            ctx.sql`update organisations set name = 'hijacked' where id = ${a.orgId} returning id`,
          AAL2,
        )
        .catch(() => []);
      expect(changed).toHaveLength(0);
      const [o] = await ctx.sql`select name from organisations where id = ${a.orgId}`;
      expect(o!.name).toBe("Shop A");
    }));
});
