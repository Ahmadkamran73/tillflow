// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, describe, expect, it } from "vitest";
import { inWorld, sql } from "./helpers";

/** Separate pool: the concurrency test needs 20 real connections, not one transaction. */
const pool = postgres(process.env.DIRECT_URL!, { max: 20, onnotice: () => {} });

afterAll(async () => {
  await pool.end();
  await sql.end();
});

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

describe("ops tables (error_events, rate_limits, job_runs)", () => {
  it("are invisible and unwritable for anon and every signed-in role", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, world.a.manager, world.a.cashier, null]) {
        for (const table of ["error_events", "rate_limits", "job_runs"]) {
          await denied(() => as(actor, () => sql`select * from ${sql(table)}`));
        }
        await denied(() =>
          as(actor, () => sql`insert into job_runs (job, period) values ('x', 'y')`),
        );
        await denied(() => as(actor, () => sql`delete from error_events`));
      }
    }));

  it("keep RLS on with a deny-all policy (so check-rls accepts them)", async () => {
    const rows = await sql<{ relname: string; rls: boolean; policies: number }[]>`
      select c.relname, c.relrowsecurity as rls,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname in ('error_events', 'rate_limits', 'job_runs')`;
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r).toMatchObject({ rls: true, policies: 1 });
  });

  it("ops functions and the pgboss schema are closed to anon and signed-in users", () =>
    inWorld(async ({ sql, world, as, denied }) => {
      for (const actor of [world.a.owner, null]) {
        await denied(() =>
          as(actor, () => sql`select * from ops.check_rate_limit('login', ${hex("x")}, 5, 60)`),
        );
        await denied(() =>
          as(
            actor,
            () =>
              sql`select * from ops.record_error(${hex("e")}, 'server', 'm', null, null, 'test')`,
          ),
        );
        await denied(() => as(actor, () => sql`select ops.heartbeat_age_seconds()`));
        await denied(() => as(actor, () => sql`select count(*) from pgboss.job`));
      }
    }));
});

describe("ops.check_rate_limit", () => {
  it("allows exactly 5 of 20 parallel calls with a limit of 5", async () => {
    const key = hex(`parallel-${randomUUID()}`);
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          pool.begin(async (tx) => {
            await tx.unsafe("set local role service_role");
            const [row] = await tx<{ allowed: boolean }[]>`
              select allowed from ops.check_rate_limit('test-parallel', ${key}, 5, 60)`;
            return row!.allowed;
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(5);
    } finally {
      await pool`delete from rate_limits where bucket = 'test-parallel' and key_hash = ${key}`;
    }
  });

  it("reports remaining and retry-after, starts a fresh window later, refuses raw identifiers", () =>
    inWorld(async ({ sql, asService, denied }) => {
      const key = hex("window");
      const check = () =>
        asService(async () => {
          const [row] = await sql<
            { allowed: boolean; remaining: number; retry_after_seconds: number }[]
          >`select * from ops.check_rate_limit('test-window', ${key}, 2, 60)`;
          return row!;
        });
      expect(await check()).toEqual({ allowed: true, remaining: 1, retry_after_seconds: 0 });
      expect(await check()).toEqual({ allowed: true, remaining: 0, retry_after_seconds: 0 });
      const refused = await check();
      expect(refused).toMatchObject({ allowed: false, remaining: 0 });
      expect(refused.retry_after_seconds).toBeGreaterThan(0);
      expect(refused.retry_after_seconds).toBeLessThanOrEqual(60);

      await sql`update rate_limits set window_start = now() - interval '61 seconds'
                where bucket = 'test-window' and key_hash = ${key}`;
      expect(await check()).toMatchObject({ allowed: true, remaining: 1 });
      // Only SHA-256 hashes are stored: an email as the key is rejected by the check constraint.
      await denied(
        () =>
          asService(
            () => sql`select * from ops.check_rate_limit('login', 'someone@example.ie', 5, 60)`,
          ),
        ["23514"],
      );
    }));

  it("keeps two keys (and two buckets) apart", () =>
    inWorld(async ({ sql, asService }) => {
      const allowed = (bucket: string, key: string) =>
        asService(async () => {
          const [row] = await sql<{ allowed: boolean }[]>`
            select allowed from ops.check_rate_limit(${bucket}, ${key}, 1, 60)`;
          return row!.allowed;
        });
      const a = hex("key-a");
      const b = hex("key-b");
      expect(await allowed("test-keys", a)).toBe(true);
      expect(await allowed("test-keys", a)).toBe(false);
      expect(await allowed("test-keys", b)).toBe(true);
      expect(await allowed("test-other-bucket", a)).toBe(true);
    }));
});

describe("ops.record_error", () => {
  const record = (sql: postgres.TransactionSql, fp: string, source = "server") =>
    sql<{ is_new: boolean; should_alert: boolean; occurrences: number }[]>`
      select * from ops.record_error(${fp}, ${source}, 'TypeError: boom', null, '/o/:id', 'test')`;

  // The 10-alerts-an-hour cap counts every row, so start each test from a quiet hour (rolled back).
  const quietHour = (sql: postgres.TransactionSql) =>
    sql`update error_events set last_alerted_at = null where last_alerted_at is not null`;

  it("never sends an instant alert for a browser report (digest only)", () =>
    inWorld(async ({ sql }) => {
      await quietHour(sql);
      const fp = hex(`browser-${randomUUID()}`);
      expect((await record(sql, fp, "browser"))[0]).toMatchObject({
        is_new: true,
        should_alert: false,
      });
    }));

  it("sends at most 10 alerts an hour in total", () =>
    inWorld(async ({ sql }) => {
      await quietHour(sql);
      const alerts: boolean[] = [];
      for (let i = 0; i < 12; i++) {
        alerts.push((await record(sql, hex(`cap-${i}-${randomUUID()}`)))[0]!.should_alert);
      }
      expect(alerts.filter(Boolean)).toHaveLength(10);
    }));

  it("alerts once for a new fingerprint, then only counts", () =>
    inWorld(async ({ sql }) => {
      await quietHour(sql);
      const fp = hex(`new-${randomUUID()}`);
      expect((await record(sql, fp))[0]).toMatchObject({
        is_new: true,
        should_alert: true,
        occurrences: 1,
      });
      expect((await record(sql, fp))[0]).toMatchObject({
        is_new: false,
        should_alert: false,
        occurrences: 2,
      });
    }));

  it("alerts again when a resolved error comes back, but not within the hour", () =>
    inWorld(async ({ sql }) => {
      await quietHour(sql);
      const fp = hex(`regress-${randomUUID()}`);
      await record(sql, fp);
      await sql`update error_events set status = 'resolved' where fingerprint = ${fp}`;
      expect((await record(sql, fp))[0]!.should_alert).toBe(false); // alerted < 1 hour ago

      await sql`update error_events set status = 'resolved', last_alerted_at = now() - interval '2 hours'
                where fingerprint = ${fp}`;
      expect((await record(sql, fp))[0]!.should_alert).toBe(true);
      const [row] = await sql`select status from error_events where fingerprint = ${fp}`;
      expect(row!.status).toBe("new");
    }));

  it("stores the scrubbed context and keeps the latest one", () =>
    inWorld(async ({ sql }) => {
      const fp = hex(`context-${randomUUID()}`);
      await sql`select * from ops.record_error(${fp}, 'server', 'm', null, null, 'test', ${sql.json({ method: "GET" })})`;
      await sql`select * from ops.record_error(${fp}, 'server', 'm', null, null, 'test', ${sql.json({ method: "POST" })})`;
      const [row] = await sql`select context from error_events where fingerprint = ${fp}`;
      expect(row!.context).toEqual({ method: "POST" });
    }));

  it("never alerts for an ignored error", () =>
    inWorld(async ({ sql }) => {
      const fp = hex(`ignored-${randomUUID()}`);
      await record(sql, fp);
      await sql`update error_events set status = 'ignored', last_alerted_at = null where fingerprint = ${fp}`;
      expect((await record(sql, fp))[0]!.should_alert).toBe(false);
    }));
});

describe("job guards and heartbeat", () => {
  it("claim_job_run is true exactly once per job and period", () =>
    inWorld(async ({ sql }) => {
      const claim = async () =>
        (
          await sql<{ ok: boolean }[]>`select ops.claim_job_run('test-digest', '2026-09-30') as ok`
        )[0]!.ok;
      expect(await claim()).toBe(true);
      expect(await claim()).toBe(false);
    }));

  it("touch_heartbeat makes heartbeat_age_seconds report a fresh beat", () =>
    inWorld(async ({ sql }) => {
      await sql`select ops.touch_heartbeat()`;
      const [row] = await sql<{ age: number }[]>`select ops.heartbeat_age_seconds() as age`;
      expect(row!.age).toBeLessThan(5);
    }));
});
