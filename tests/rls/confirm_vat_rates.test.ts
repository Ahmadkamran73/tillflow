// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { enrolTotp, inWorld, sql } from "./helpers";

afterAll(() => sql.end());

describe("confirm_vat_rates", () => {
  it("the owner confirms: who, when, and the rates in force are recorded", () =>
    inWorld(async ({ sql, world, as }) => {
      const org = world.a.orgId;
      await as(world.a.owner, () => sql`select public.confirm_vat_rates(${org}, ${randomUUID()})`);
      const [o] =
        await sql`select vat_rates_confirmed_at, vat_rates_confirmed_by from organisations where id = ${org}`;
      expect(o!.vat_rates_confirmed_at).not.toBeNull();
      expect(o!.vat_rates_confirmed_by).toBe(world.a.owner.userId);

      const [audit] =
        await sql`select after from audit_log where org_id = ${org} and action = 'organisation.vat_rates_confirmed'`;
      const rates = audit!.after.rates as { code: string; rate_bp: number }[];
      expect(audit!.after.country).toBe("IE");
      expect(rates.find((r) => r.code === "STANDARD")?.rate_bp).toBe(2300);
      expect(rates.find((r) => r.code === "CATERING")?.rate_bp).toBe(900);

      // Confirming again is allowed and logged again.
      await as(world.a.owner, () => sql`select public.confirm_vat_rates(${org}, ${randomUUID()})`);
      expect(
        await sql`select 1 from audit_log where org_id = ${org} and action = 'organisation.vat_rates_confirmed'`,
      ).toHaveLength(2);
      // Shop B is untouched.
      const [b] =
        await sql`select vat_rates_confirmed_at from organisations where id = ${world.b.orgId}`;
      expect(b!.vat_rates_confirmed_at).toBeNull();
    }));

  it("managers, cashiers, other shops, aal1 owners and anon are refused; columns are not writable", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const org = world.a.orgId;
      const call = () => sql`select public.confirm_vat_rates(${org}, ${randomUUID()})`;
      for (const actor of [world.a.manager, world.a.cashier, world.b.owner]) {
        await denied(() => as(actor, call), ["42501"]);
      }
      await enrolTotp(sql, world.a.owner);
      await denied(() => as(world.a.owner, call, { aal: "aal1" }), ["42501"]);
      await denied(() => as(null, call), ["42501"]);
      await denied(
        () =>
          as(
            world.a.owner,
            () => sql`update organisations set vat_rates_confirmed_at = now() where id = ${org}`,
          ),
        ["42501"],
      );
      const [o] = await sql`select vat_rates_confirmed_at from organisations where id = ${org}`;
      expect(o!.vat_rates_confirmed_at).toBeNull();
    }));
});
