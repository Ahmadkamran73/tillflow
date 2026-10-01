// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opsRoleUrl, sql } from "./helpers";

/** The app's privileged connection (tillflow_ops, migration 0008) can reach ops.* and nothing else. */
let ops: postgres.Sql;

beforeAll(async () => {
  ops = postgres(await opsRoleUrl(), { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await ops.end();
  await sql.end();
});

async function refused(query: () => PromiseLike<unknown>) {
  let error: unknown;
  try {
    await query();
  } catch (e) {
    error = e;
  }
  expect(error, "expected the statement to be refused").toBeDefined();
  expect((error as { code?: string }).code).toBe("42501");
}

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("tillflow_ops role", () => {
  it("cannot read or write any business or platform table directly", async () => {
    for (const table of [
      "organisations",
      "memberships",
      "locations",
      "registers",
      "audit_log",
      "error_events",
      "rate_limits",
      "job_runs",
    ]) {
      await refused(() => ops`select 1 from ${ops(table)} limit 1`);
    }
    await refused(() => ops`delete from organisations`);
    await refused(() => ops`create table public.ops_probe (id int)`);
  });

  it("cannot call the sign-up function or bypass RLS", async () => {
    await refused(
      () =>
        ops`select public.create_my_organisation(${randomUUID()}, ${randomUUID()}, ${randomUUID()}, 'x')`,
    );
    const [role] = await ops<{ bypass: boolean; superuser: boolean }[]>`
      select rolbypassrls as bypass, rolsuper as superuser from pg_roles where rolname = current_user`;
    expect(role).toEqual({ bypass: false, superuser: false });
  });

  it("can use the ops functions", async () => {
    const key = hex(`ops-role-${randomUUID()}`);
    try {
      const [row] = await ops<{ allowed: boolean }[]>`
        select allowed from ops.check_rate_limit('test-ops-role', ${key}, 5, 60)`;
      expect(row!.allowed).toBe(true);
      await ops`select ops.touch_heartbeat()`;
      const [beat] = await ops<{ age: number }[]>`select ops.heartbeat_age_seconds() as age`;
      expect(beat!.age).toBeLessThan(5);
    } finally {
      await sql`delete from rate_limits where bucket = 'test-ops-role'`;
    }
  });
});
