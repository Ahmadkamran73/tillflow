// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createBoss, registerHandler, type JobHandler } from "@/lib/jobs/boss";
import { opsRoleUrl, sql } from "./helpers";

/**
 * pg-boss against the local database (schema 0007), connected as the least-privilege
 * tillflow_ops role (0008) exactly like the app. Each test uses its own queue name.
 */
let url: string;
const bosses: PgBoss[] = [];

async function startBoss(): Promise<PgBoss> {
  const boss = createBoss(url);
  boss.on("error", () => {});
  await boss.start();
  bosses.push(boss);
  return boss;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const FAST = { pollingIntervalSeconds: 0.5 };
const payload = z.object({ n: z.number() });

let boss: PgBoss;
beforeAll(async () => {
  url = await opsRoleUrl();
  boss = await startBoss();
});
afterAll(async () => {
  for (const b of bosses) await b.stop({ graceful: false, close: true });
  await sql.end();
});

describe("pg-boss jobs", () => {
  it("processes an enqueued job exactly once", { timeout: 30_000 }, async () => {
    const seen: number[] = [];
    const handler: JobHandler<typeof payload> = {
      name: `test-once-${randomUUID()}`,
      schema: payload,
      handle: async (data) => void seen.push(data.n),
    };
    await registerHandler(boss, handler, { retryLimit: 0 }, FAST);
    const id = await boss.send(handler.name, { n: 42 });
    await until(async () => (await boss.getJobById(handler.name, id!))?.state === "completed");
    await new Promise((r) => setTimeout(r, 1_500)); // give a second pickup the chance to happen
    expect(seen).toEqual([42]);
    await boss.deleteQueue(handler.name);
  });

  it("retries a failing job, then leaves it failed", { timeout: 30_000 }, async () => {
    let attempts = 0;
    const handler: JobHandler<typeof payload> = {
      name: `test-fail-${randomUUID()}`,
      schema: payload,
      handle: async () => {
        attempts += 1;
        throw new Error("always fails");
      },
    };
    await registerHandler(boss, handler, { retryLimit: 2, retryDelay: 0 }, FAST);
    const id = await boss.send(handler.name, { n: 1 });
    await until(async () => (await boss.getJobById(handler.name, id!))?.state === "failed");
    const job = await boss.getJobById(handler.name, id!);
    expect(attempts).toBe(3); // first try + 2 retries
    expect(job!.retryCount).toBe(2);
    await boss.deleteQueue(handler.name);
  });

  it("rejects a payload that fails the handler's schema", { timeout: 30_000 }, async () => {
    let ran = false;
    const handler: JobHandler<typeof payload> = {
      name: `test-schema-${randomUUID()}`,
      schema: payload,
      handle: async () => {
        ran = true;
      },
    };
    await registerHandler(boss, handler, { retryLimit: 0 }, FAST);
    const id = await boss.send(handler.name, { n: "not a number" });
    await until(async () => (await boss.getJobById(handler.name, id!))?.state === "failed");
    expect(ran).toBe(false);
    await boss.deleteQueue(handler.name);
  });

  it("never runs the same job on two workers", { timeout: 40_000 }, async () => {
    const second = await startBoss();
    const runs: number[] = [];
    const handler: JobHandler<typeof payload> = {
      name: `test-two-workers-${randomUUID()}`,
      schema: payload,
      handle: async (data) => {
        runs.push(data.n);
        await new Promise((r) => setTimeout(r, 20));
      },
    };
    await registerHandler(boss, handler, { retryLimit: 0 }, FAST);
    await registerHandler(second, handler, { retryLimit: 0 }, FAST);
    for (let n = 0; n < 30; n++) await boss.send(handler.name, { n });
    await until(() => runs.length >= 30);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(runs).toHaveLength(30);
    expect(new Set(runs).size).toBe(30);
    await boss.deleteQueue(handler.name);
  });
});
