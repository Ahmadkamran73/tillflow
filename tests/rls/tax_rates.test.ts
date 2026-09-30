// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";

afterAll(() => sql.end());

const rateOn = (code: string, date: string) =>
  sql`select rate_bp from tax_rates where country = 'IE' and code = ${code} and valid_from <= ${date}::date and (valid_to is null or valid_to >= ${date}::date)`;

describe("tax_rates", () => {
  it("is readable by signed-in users, not by anon", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      const rows = await as(world.a.cashier, () => sql`select code from tax_rates`);
      expect(rows.length).toBeGreaterThan(0);
      await denied(() => as(null, () => sql`select code from tax_rates`));
    }));

  it("cannot be written by anyone through the API, not even the owner or service role", () =>
    inWorld(async ({ sql, world, as, asService, denied }) => {
      const ins = () =>
        sql`insert into tax_rates (id, country, code, description, rate_bp, valid_from) values (${randomUUID()}, 'IE', 'HACK', 'x', 0, '2030-01-01')`;
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier, null]) {
        await denied(() => as(actor, ins));
        await denied(() => as(actor, () => sql`update tax_rates set rate_bp = 0`));
        await denied(() => as(actor, () => sql`delete from tax_rates`));
      }
      await denied(() => asService(ins));
    }));

  it("seeds the 1 July 2026 catering and hairdressing change (13.5% to 9%)", () =>
    inWorld(async () => {
      for (const code of ["CATERING", "HAIRDRESSING"]) {
        expect((await rateOn(code, "2026-06-30")).map((r) => r.rate_bp)).toEqual([1350]);
        expect((await rateOn(code, "2026-07-01")).map((r) => r.rate_bp)).toEqual([900]);
      }
      expect((await rateOn("STANDARD", "2026-09-29")).map((r) => r.rate_bp)).toEqual([2300]);
      expect((await rateOn("REDUCED", "2026-09-29")).map((r) => r.rate_bp)).toEqual([1350]);
      expect((await rateOn("ZERO", "2026-09-29")).map((r) => r.rate_bp)).toEqual([0]);
    }));

  it("rejects overlapping periods for the same code", () =>
    inWorld(async ({ sql, denied }) => {
      await denied(
        () =>
          sql`insert into tax_rates (id, country, code, description, rate_bp, valid_from) values (${randomUUID()}, 'IE', 'CATERING', 'overlap', 1000, '2027-01-01')`,
        ["23P01"],
      );
    }));
});
