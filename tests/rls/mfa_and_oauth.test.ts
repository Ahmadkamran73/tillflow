// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import { enrolTotp, inWorld, sql } from "./helpers";

afterAll(() => sql.end());

const AAL1 = { aal: "aal1" as const };
const GOOGLE = { aal: "aal1" as const, amr: [{ method: "oauth" }] };
const GOOGLE_AAL2 = { aal: "aal2" as const, amr: [{ method: "oauth" }, { method: "totp" }] };

describe("an owner who set up an authenticator is held to aal2 by RLS", () => {
  it("an owner with no authenticator is not blocked at aal1 (two-step is optional)", () =>
    inWorld(async ({ sql, world, as }) => {
      const orgs = await as(world.a.owner, () => sql`select id from organisations`, AAL1);
      expect(orgs).toEqual([{ id: world.a.orgId }]);
    }));

  it("an owner at aal1 sees no organisation data at all", () =>
    inWorld(async ({ sql, world, as }) => {
      const owner = world.a.owner;
      await enrolTotp(sql, owner);
      expect(await as(owner, () => sql`select id from organisations`, AAL1)).toHaveLength(0);
      expect(await as(owner, () => sql`select id from locations`, AAL1)).toHaveLength(0);
      expect(await as(owner, () => sql`select id from registers`, AAL1)).toHaveLength(0);
      expect(await as(owner, () => sql`select id from audit_log`, AAL1)).toHaveLength(0);
    }));

  it("an owner at aal1 cannot write either", () =>
    inWorld(async ({ sql, world, as }) => {
      const owner = world.a.owner;
      await enrolTotp(sql, owner);
      const renamed = await as(
        owner,
        () =>
          sql`update organisations set name = 'Hijacked' where id = ${world.a.orgId} returning id`,
        AAL1,
      );
      expect(renamed).toHaveLength(0);
      const [row] = await sql`select name from organisations where id = ${world.a.orgId}`;
      expect(row?.name).toBe("Shop A");
    }));

  it("an owner at aal1 can still read only their own membership rows (so the app can ask for MFA)", () =>
    inWorld(async ({ sql, world, as }) => {
      await enrolTotp(sql, world.a.owner);
      const rows = await as(world.a.owner, () => sql`select user_id, role from memberships`, AAL1);
      expect(rows).toEqual([{ user_id: world.a.owner.userId, role: "owner" }]);
    }));

  it("the same owner at aal2 sees the whole org and still nothing of Shop B", () =>
    inWorld(async ({ sql, world, as }) => {
      const orgs = await as(world.a.owner, () => sql`select id from organisations`);
      expect(orgs).toEqual([{ id: world.a.orgId }]);
      const members = await as(world.a.owner, () => sql`select id from memberships`);
      expect(members).toHaveLength(3);
    }));

  it("a manager with no authenticator is not affected at aal1", () =>
    inWorld(async ({ sql, world, as }) => {
      const orgs = await as(world.a.manager, () => sql`select id from organisations`, AAL1);
      expect(orgs).toEqual([{ id: world.a.orgId }]);
    }));

  it("a manager who has set up an authenticator needs aal2", () =>
    inWorld(async ({ sql, world, as }) => {
      await enrolTotp(sql, world.a.manager);
      expect(await as(world.a.manager, () => sql`select id from organisations`, AAL1)).toHaveLength(
        0,
      );
      expect(await as(world.a.manager, () => sql`select id from organisations`)).toHaveLength(1);
    }));
});

describe("OAuth (Google) sessions never carry cashier access", () => {
  it("a cashier signed in via Google sees no organisation data, only their own membership", () =>
    inWorld(async ({ sql, world, as }) => {
      const cashier = world.a.cashier;
      expect(await as(cashier, () => sql`select id from organisations`, GOOGLE)).toHaveLength(0);
      expect(await as(cashier, () => sql`select id from locations`, GOOGLE_AAL2)).toHaveLength(0);
      const own = await as(cashier, () => sql`select role from memberships`, GOOGLE);
      expect(own).toEqual([{ role: "cashier" }]);
    }));

  it("the same cashier with a password session still works", () =>
    inWorld(async ({ sql, world, as }) => {
      const orgs = await as(world.a.cashier, () => sql`select id from organisations`, AAL1);
      expect(orgs).toEqual([{ id: world.a.orgId }]);
    }));

  it("a manager signed in via Google keeps access", () =>
    inWorld(async ({ sql, world, as }) => {
      const orgs = await as(world.a.manager, () => sql`select id from organisations`, GOOGLE);
      expect(orgs).toEqual([{ id: world.a.orgId }]);
    }));
});
