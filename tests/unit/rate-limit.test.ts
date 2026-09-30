import { describe, expect, it } from "vitest";
import { createMemoryLimiter } from "@/lib/rate-limit/memory";

describe("in-memory limiter (5 per minute)", () => {
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
});
