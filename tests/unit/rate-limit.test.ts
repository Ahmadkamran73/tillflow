// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";

const checkRateLimit = vi.fn();
const reportError = vi.fn();
vi.mock("@/lib/ops/db", () => ({ checkRateLimit }));
vi.mock("@/lib/errors", () => ({ reportError }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

const {
  authRateLimitError,
  rateLimit,
  rateLimitedMessage,
  RATE_LIMITS,
  RATE_LIMIT_UNAVAILABLE_MESSAGE,
  memoryRateLimit,
} = await import("@/lib/rate-limit");

const allowed = { allowed: true, remaining: 4, retryAfterSeconds: 0 };

describe("policies", () => {
  it("match the spec", () => {
    expect(RATE_LIMITS.login).toMatchObject({ limit: 5, windowSec: 60, auth: true });
    expect(RATE_LIMITS["login-account"]).toMatchObject({ limit: 20, windowSec: 900, auth: true });
    expect(RATE_LIMITS["reset-account"]).toMatchObject({ limit: 3, windowSec: 3600 });
    expect(RATE_LIMITS["reset-ip"]).toMatchObject({ limit: 10, windowSec: 3600 });
    expect(RATE_LIMITS.export).toMatchObject({ limit: 5, windowSec: 3600, auth: false });
    expect(RATE_LIMITS.import).toMatchObject({ limit: 5, windowSec: 3600, auth: false });
  });
});

describe("Postgres limiter", () => {
  beforeEach(() => {
    checkRateLimit.mockReset();
    reportError.mockReset();
  });

  it("sends the policy and only a SHA-256 hash of the key", async () => {
    checkRateLimit.mockResolvedValue(allowed);
    expect(await authRateLimitError("login", "1.2.3.4", "owner@shop.ie")).toBeNull();
    const [bucket, keyHash, limit, windowSec] = checkRateLimit.mock.calls[0]!;
    expect([bucket, limit, windowSec]).toEqual(["login", 5, 60]);
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("tells the user how long to wait", async () => {
    checkRateLimit.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 1500 });
    expect(await authRateLimitError("reset-account", "a@b.ie")).toBe(
      "Too many attempts. Try again in 25 minutes.",
    );
    expect(rateLimitedMessage(40)).toBe("Too many attempts. Wait a minute and try again.");
  });

  it("fails CLOSED for auth limits and logs", async () => {
    checkRateLimit.mockRejectedValue(new Error("connection refused"));
    expect(await authRateLimitError("mfa", "user-1")).toBe(RATE_LIMIT_UNAVAILABLE_MESSAGE);
    expect(RATE_LIMIT_UNAVAILABLE_MESSAGE).toMatch(/try again shortly/);
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError.mock.calls[0]![1]).toMatchObject({ context: { bucket: "mfa" } });
  });

  it("fails OPEN for other limits and logs", async () => {
    checkRateLimit.mockRejectedValue(new Error("connection refused"));
    expect(await rateLimit("export", "user-1")).toMatchObject({ allowed: true, unavailable: true });
    expect(reportError).toHaveBeenCalledOnce();
  });
});

describe("in-memory limiter (sync, log-error)", () => {
  it("allows five attempts, refuses the sixth, and frees up after the window", () => {
    let t = 1_000;
    const limiter = createMemoryLimiter(5, 60_000, () => t);
    for (let i = 0; i < 5; i++) expect(limiter.take("ip|a@b.ie")).toBe(true);
    expect(limiter.take("ip|a@b.ie")).toBe(false);
    t += 59_999;
    expect(limiter.take("ip|a@b.ie")).toBe(false);
    t += 2;
    expect(limiter.take("ip|a@b.ie")).toBe(true);
  });

  it("counts each key separately", () => {
    const limiter = createMemoryLimiter(1, 60_000, () => 0);
    expect(limiter.take("one")).toBe(true);
    expect(limiter.take("one")).toBe(false);
    expect(limiter.take("two")).toBe(true);
  });

  it("does not count refused attempts against the window", () => {
    let t = 0;
    const limiter = createMemoryLimiter(1, 1_000, () => t);
    expect(limiter.take("k")).toBe(true);
    t = 900;
    expect(limiter.take("k")).toBe(false);
    t = 1_001; // only the first (allowed) hit ages out; hammering did not extend the lock
    expect(limiter.take("k")).toBe(true);
  });

  it("memoryRateLimit keeps a separate limiter per name", () => {
    expect(memoryRateLimit("bucket-a", "ip", 1, 60_000)).toBe(true);
    expect(memoryRateLimit("bucket-a", "ip", 1, 60_000)).toBe(false);
    expect(memoryRateLimit("bucket-b", "ip", 1, 60_000)).toBe(true);
  });
});
