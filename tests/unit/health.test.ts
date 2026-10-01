// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const heartbeatAgeSeconds = vi.fn();
vi.mock("@/lib/ops/db", () => ({ heartbeatAgeSeconds }));

const { GET } = await import("@/app/api/health/route");

// The route caches the probe for 10 s; move the clock past that before each request.
let clock = Date.now();
async function GET_() {
  clock += 11_000;
  vi.setSystemTime(clock);
  return GET();
}

beforeEach(() => {
  heartbeatAgeSeconds.mockReset();
});

it("asks the database at most once per 10 seconds", async () => {
  heartbeatAgeSeconds.mockResolvedValue(30);
  await GET_();
  await GET();
  await GET();
  expect(heartbeatAgeSeconds).toHaveBeenCalledOnce();
});

it("is 200 with jobs ok when the database answers and the worker beat recently", async () => {
  heartbeatAgeSeconds.mockResolvedValue(30);
  const res = await GET_();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ status: "ok", database: "ok", jobs: "ok" });
  expect(body).toHaveProperty("version");
  expect(body).toHaveProperty("commit");
});

it("stays 200 but reports jobs down after 5 minutes without a heartbeat, or none at all", async () => {
  for (const age of [301, null]) {
    heartbeatAgeSeconds.mockResolvedValue(age);
    const res = await GET_();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", jobs: "down" });
  }
  heartbeatAgeSeconds.mockResolvedValue(300);
  expect(await (await GET_()).json()).toMatchObject({ jobs: "ok" });
});

it("is 503 only when the database does not answer", async () => {
  heartbeatAgeSeconds.mockImplementation(async () => {
    throw new Error("connection refused");
  });
  const res = await GET_();
  expect(res.status).toBe(503);
  expect(await res.json()).toMatchObject({ status: "down", database: "down", jobs: "down" });
});
