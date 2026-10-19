// @vitest-environment node
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { seedProduct } from "./catalog-helpers";
import { inWorld, sql, type Actor, type Ctx, type Shop } from "./helpers";

afterAll(() => sql.end());

const json = (ctx: Ctx, v: unknown) => ctx.sql.json(v as postgres.JSONValue);

type Purpose = "discount" | "no_sale" | "refund";

/** What the unlock route does after a manager's PIN was verified: the server issues the proof. */
const issue = async (ctx: Ctx, shop: Shop, who: Actor, purpose: Purpose) =>
  (
    await ctx.sql`select ops.issue_approval(${shop.tokenHash}, ${who.userId}, ${purpose},
                    ${purpose === "refund" ? randomUUID() : null}::uuid,
                    ${purpose === "refund" ? 100 : null}::integer) as id`
  )[0]!.id as string;

const event = (shop: Shop, over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  kind: "no_sale",
  at: new Date().toISOString(),
  cashier_user_id: shop.cashier.userId,
  approval_id: null,
  claimed_approver: null,
  detail: {},
  ...over,
});

const record = (ctx: Ctx, token: string, events: unknown[]) =>
  ctx.sql`select * from ops.record_register_events(${token}, ${json(ctx, events)})`;

const refused = (ctx: Ctx, run: () => PromiseLike<unknown>, code = "42501") =>
  expect(ctx.sql.savepoint(async () => run())).rejects.toMatchObject({ code });

/** A €7.00 two-unit sale with a €1.00 line discount. */
function discountedSale(shop: Shop, vid: string, pid: string, over: Record<string, unknown> = {}) {
  return {
    sale: {
      id: randomUUID(),
      org_id: shop.orgId,
      register_id: shop.registerId,
      user_id: shop.cashier.userId,
      receipt_seq: 1,
      mode: "eat_in",
      completed_at: new Date().toISOString(),
      priced_as_of: new Date().toISOString(),
      items_total: 600,
      vat: 112,
      non_vat: 0,
      cash_rounding: 0,
      amount_due: 600,
      client_due: 600,
      ...over,
    },
    lines: [
      {
        kind: "item",
        variant_id: vid,
        product_id: pid,
        name: "Tea",
        qty: 2,
        unit_price_cents: 350,
        modifiers: [],
        discount_cents: 100,
        tax_category: "STANDARD",
        tax_rate_bp: 2300,
        net_cents: 488,
        vat_cents: 112,
        gross_cents: 600,
      },
    ],
    payment: { method: "cash", amount: 600, tendered: 600, change: 0 },
  };
}

const saleAudit = async (ctx: Ctx, shop: Shop) =>
  ctx.sql`select actor_user_id, after from audit_log
          where org_id = ${shop.orgId} and action = 'sale.discount_override'`;

describe("ops.issue_approval", () => {
  it("is issued only for a manager or owner of the till's shop, with a known purpose", () =>
    inWorld(async (ctx) => {
      const { world } = ctx;
      expect(await issue(ctx, world.a, world.a.manager, "discount")).toMatch(/^[0-9a-f-]{36}$/);
      expect(await issue(ctx, world.a, world.a.owner, "no_sale")).toMatch(/^[0-9a-f-]{36}$/);
      await refused(ctx, () => issue(ctx, world.a, world.a.cashier, "discount")); // not a manager
      await refused(ctx, () => issue(ctx, world.a, world.b.manager, "discount")); // another shop's
      await refused(
        ctx,
        () => issue(ctx, world.a, world.a.manager, "free_money" as Purpose),
        "22023",
      );
      await refused(
        ctx,
        () =>
          ctx.sql`select ops.issue_approval(${"0".repeat(64)}, ${world.a.manager.userId}, 'discount')`,
      ); // unpaired till
    }));

  it("clients cannot call it, and the approvals table is read-only for managers only", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      await issue(ctx, world.a, world.a.manager, "discount");
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier, null]) {
        await denied(() =>
          as(
            actor,
            () =>
              sql`select ops.issue_approval(${world.a.tokenHash}, ${world.a.manager.userId}, 'discount')`,
          ),
        );
        await denied(() =>
          as(
            actor,
            () => sql`insert into register_approvals (id, org_id, register_id, approver_user_id, purpose)
          values (${randomUUID()}, ${world.a.orgId}, ${world.a.registerId}, ${world.a.manager.userId}, 'discount')`,
          ),
        );
      }
      expect(await as(world.a.manager, () => sql`select id from register_approvals`)).toHaveLength(
        1,
      );
      for (const actor of [world.a.cashier, world.b.owner, world.b.manager]) {
        expect(await as(actor, () => sql`select id from register_approvals`)).toHaveLength(0);
      }
      await denied(() =>
        as(world.a.owner, () => sql`update register_approvals set consumed_at = null`),
      );
      await denied(() => as(world.a.owner, () => sql`delete from register_approvals`));
    }));
});

describe("ops.record_sale with a manager approval", () => {
  it("derives the approver from the server-issued approval and audits it as PIN-verified", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const approval = await issue(ctx, world.a, world.a.manager, "discount");
      const p = discountedSale(world.a, vid, pid, { approval_id: approval });
      expect((await sql`select ops.record_sale(${json(ctx, p)}) as r`)[0]!.r).toBe("created");

      const [row] = await saleAudit(ctx, world.a);
      expect(row!.actor_user_id).toBe(world.a.cashier.userId);
      expect(row!.after).toMatchObject({
        approved_by: world.a.manager.userId,
        approval: "pin_verified",
        discount_cents: 100,
      });
      const [a] =
        await sql`select consumed_at, consumed_for from register_approvals where id = ${approval}`;
      expect(a!.consumed_at).not.toBeNull();
      expect(a!.consumed_for).toBe(p.sale.id);

      // A replay is a duplicate: it neither fails on the spent approval nor logs a second override.
      expect((await sql`select ops.record_sale(${json(ctx, p)}) as r`)[0]!.r).toBe("duplicate");
      expect(await saleAudit(ctx, world.a)).toHaveLength(1);
    }));

  it("an approval is single use: it cannot cover a second sale", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const approval = await issue(ctx, world.a, world.a.manager, "discount");
      await sql`select ops.record_sale(${json(ctx, discountedSale(world.a, vid, pid, { approval_id: approval }))})`;
      const second = discountedSale(world.a, vid, pid, { approval_id: approval, receipt_seq: 2 });
      await refused(ctx, () => sql`select ops.record_sale(${json(ctx, second)})`);
      expect(await sql`select 1 from sales where id = ${second.sale.id}`).toHaveLength(0);
    }));

  it("a made-up approval id, another shop's approval, another till's approval or the wrong purpose all fail, writing nothing", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      // A second till in Shop A.
      const till2 = randomUUID();
      const till2Hash = "f".repeat(64);
      await sql`insert into registers (id, org_id, location_id, name, device_token_hash)
                values (${till2}, ${world.a.orgId}, ${world.a.locationId}, 'Till 2', ${till2Hash})`;

      const others = [
        randomUUID(), // forged
        await issue(ctx, world.b, world.b.manager, "discount"), // Shop B's manager, Shop B's till
        (
          await sql`select ops.issue_approval(${till2Hash}, ${world.a.manager.userId}, 'discount') as id`
        )[0]!.id, // Till 2's
        await issue(ctx, world.a, world.a.manager, "no_sale"), // wrong purpose
      ];
      for (const approval of others) {
        const p = discountedSale(world.a, vid, pid, { approval_id: approval });
        await refused(ctx, () => sql`select ops.record_sale(${json(ctx, p)})`);
      }
      expect(await sql`select 1 from sales where org_id = ${world.a.orgId}`).toHaveLength(0);
      expect(await saleAudit(ctx, world.a)).toHaveLength(0);
    }));

  it("an approval covers only sales made within 30 minutes of the PIN check", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const approval = await issue(ctx, world.a, world.a.manager, "discount");
      await sql`update register_approvals set created_at = now() - interval '2 hours' where id = ${approval}`;
      // A sale made now is far past the window...
      await refused(
        ctx,
        () =>
          sql`select ops.record_sale(${json(ctx, discountedSale(world.a, vid, pid, { approval_id: approval }))})`,
      );
      // ...but a sale made right after the PIN check, synced hours later, is fine (judged by its own time).
      const then = new Date(Date.now() - 2 * 3_600_000 + 5 * 60_000).toISOString();
      const late = discountedSale(world.a, vid, pid, { approval_id: approval, completed_at: then });
      expect((await sql`select ops.record_sale(${json(ctx, late)}) as r`)[0]!.r).toBe("created");
      // And one made before the PIN was entered is not covered.
      const approval2 = await issue(ctx, world.a, world.a.manager, "discount");
      const before = new Date(Date.now() - 10 * 60_000).toISOString();
      await refused(
        ctx,
        () =>
          sql`select ops.record_sale(${json(ctx, discountedSale(world.a, vid, pid, { approval_id: approval2, completed_at: before, receipt_seq: 9 }))})`,
      );
    }));

  it("an approver who has since been demoted or removed no longer counts", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const approval = await issue(ctx, world.a, world.a.manager, "discount");
      await sql`update memberships set role = 'cashier' where user_id = ${world.a.manager.userId}`;
      await refused(
        ctx,
        () =>
          sql`select ops.record_sale(${json(ctx, discountedSale(world.a, vid, pid, { approval_id: approval }))})`,
      );
    }));

  it("a till naming an approver directly is the trusted-caller path: only managers pass, and it is labelled", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      const ok = discountedSale(world.a, vid, pid, { approved_by: world.a.manager.userId });
      await sql`select ops.record_sale(${json(ctx, ok)})`;
      expect((await saleAudit(ctx, world.a))[0]!.after).toMatchObject({
        approval: "manager_session",
      });
      for (const approver of [world.a.cashier.userId, world.b.manager.userId, randomUUID()]) {
        const p = discountedSale(world.a, vid, pid, { approved_by: approver, receipt_seq: 5 });
        await refused(ctx, () => sql`select ops.record_sale(${json(ctx, p)})`);
      }
    }));

  it("a sale without any approval writes no override row", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const { pid, vid } = await seedProduct(ctx, world.a.orgId);
      await sql`select ops.record_sale(${json(ctx, discountedSale(world.a, vid, pid))})`;
      expect(await saleAudit(ctx, world.a)).toHaveLength(0);
    }));
});

describe("register events (no-sale drawer opens, refund approvals)", () => {
  it("a server-issued approval is logged as PIN-verified, naming the approver the server saw", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const approval = await issue(ctx, world.a, world.a.manager, "no_sale");
      const e = event(world.a, { approval_id: approval, detail: { reason: "change for the bus" } });
      expect(await record(ctx, world.a.tokenHash, [e])).toHaveLength(1);
      expect(await record(ctx, world.a.tokenHash, [e])).toHaveLength(1); // replay: acknowledged, not repeated

      const rows = await sql`select actor_user_id, entity_id, after from audit_log
        where org_id = ${world.a.orgId} and action = 'register.no_sale'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actor_user_id: world.a.cashier.userId,
        entity_id: world.a.registerId,
      });
      expect(rows[0]!.after).toMatchObject({
        approval: "pin_verified",
        approved_by: world.a.manager.userId,
        claimed_approver: null,
        detail: { reason: "change for the bus" },
      });
    }));

  it("without proof (offline) the row says so, and the named manager is only a claim", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      await record(ctx, world.a.tokenHash, [
        event(world.a, { claimed_approver: world.a.owner.userId }),
        event(world.a),
      ]);
      const rows = await sql`select after from audit_log
        where org_id = ${world.a.orgId} and action = 'register.no_sale' order by (after ->> 'claimed_approver') nulls last`;
      expect(rows).toHaveLength(2);
      expect(rows[0]!.after).toMatchObject({
        approval: "unverified_offline",
        approved_by: null,
        claimed_approver: world.a.owner.userId,
      });
      expect(rows[1]!.after).toMatchObject({ approval: "unverified_offline", approved_by: null });
    }));

  it("a refund approval is logged as override.refund and needs a refund-purpose approval", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const good = await issue(ctx, world.a, world.a.owner, "refund");
      await record(ctx, world.a.tokenHash, [
        event(world.a, { kind: "refund_override", approval_id: good }),
      ]);
      expect(
        await sql`select 1 from audit_log where org_id = ${world.a.orgId} and action = 'override.refund'`,
      ).toHaveLength(1);
      const wrong = await issue(ctx, world.a, world.a.owner, "no_sale");
      await refused(ctx, () =>
        record(ctx, world.a.tokenHash, [
          event(world.a, { kind: "refund_override", approval_id: wrong }),
        ]),
      );
    }));

  it("forged, spent, another shop's and expired approvals are refused; nothing is written", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const spent = await issue(ctx, world.a, world.a.manager, "no_sale");
      await record(ctx, world.a.tokenHash, [event(world.a, { approval_id: spent })]);
      const expired = await issue(ctx, world.a, world.a.manager, "no_sale");
      await sql`update register_approvals set created_at = now() - interval '2 hours' where id = ${expired}`;
      const theirs = await issue(ctx, world.b, world.b.manager, "no_sale");

      for (const approval of [randomUUID(), spent, expired, theirs]) {
        await refused(ctx, () =>
          record(ctx, world.a.tokenHash, [event(world.a, { approval_id: approval })]),
        );
      }
      const n = await sql`select count(*)::int as n from audit_log
        where org_id = ${world.a.orgId} and action = 'register.no_sale'`;
      expect(n[0]!.n).toBe(1); // only the first, genuine one
    }));

  it("a claimed approver must at least be a manager here; a cashier of another shop cannot be the actor", () =>
    inWorld(async (ctx) => {
      const { world } = ctx;
      await refused(ctx, () =>
        record(ctx, world.a.tokenHash, [
          event(world.a, { claimed_approver: world.a.cashier.userId }),
        ]),
      );
      await refused(ctx, () =>
        record(ctx, world.a.tokenHash, [
          event(world.a, { claimed_approver: world.b.manager.userId }),
        ]),
      );
      await refused(ctx, () =>
        record(ctx, world.a.tokenHash, [
          event(world.a, { cashier_user_id: world.b.cashier.userId }),
        ]),
      );
    }));

  it("one bad event refuses the whole batch", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      await refused(ctx, () =>
        record(ctx, world.a.tokenHash, [
          event(world.a),
          event(world.a, { approval_id: randomUUID() }),
        ]),
      );
      const n = await sql`select count(*)::int as n from audit_log
        where org_id = ${world.a.orgId} and action = 'register.no_sale'`;
      expect(n[0]!.n).toBe(0);
    }));

  it("unknown kinds, unpaired devices and clients never write into Shop A", () =>
    inWorld(async (ctx) => {
      const { sql, world, as, denied } = ctx;
      await refused(
        ctx,
        () => record(ctx, world.a.tokenHash, [event(world.a, { kind: "sale_deleted" })]),
        "22023",
      );
      await refused(ctx, () => record(ctx, "0".repeat(64), [event(world.a)]));
      await refused(ctx, () => record(ctx, world.b.tokenHash, [event(world.a)])); // Shop B's till, Shop A's people
      for (const actor of [world.a.owner, world.a.cashier, null]) {
        await denied(() =>
          as(
            actor,
            () => sql`select * from ops.record_register_events(${world.a.tokenHash}, '[]'::jsonb)`,
          ),
        );
      }
    }));

  it("an event id already used by another shop's audit row is not reported as recorded", () =>
    inWorld(async (ctx) => {
      const { sql, world } = ctx;
      const e = event(world.a);
      await record(ctx, world.a.tokenHash, [e]);
      const echoed = await record(ctx, world.b.tokenHash, [{ ...event(world.b), id: e.id }]);
      expect(echoed).toHaveLength(0); // not ours, so not acknowledged
      expect(await sql`select org_id from audit_log where id = ${e.id}`).toEqual([
        { org_id: world.a.orgId },
      ]);
    }));
});
