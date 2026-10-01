// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  claimJobRun: vi.fn(),
  cleanupRateLimits: vi.fn(),
  errorDigest: vi.fn(),
  pruneErrorEvents: vi.fn(),
  pruneJobRuns: vi.fn(),
  touchHeartbeat: vi.fn(),
};
const sendAlertEmail = vi.fn();
vi.mock("@/lib/ops/db", () => db);
vi.mock("@/lib/errors/alert", () => ({ sendAlertEmail }));

const { dublinClock, errorDigestJob, errorPrune } = await import("@/lib/jobs/handlers/ops");

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  sendAlertEmail.mockReset();
});

describe("dublinClock", () => {
  it("uses Irish time in summer (UTC+1) and winter (UTC+0)", () => {
    expect(dublinClock(new Date("2026-07-01T07:30:00Z"))).toEqual({ date: "2026-07-01", hour: 8 });
    expect(dublinClock(new Date("2026-12-01T07:30:00Z"))).toEqual({ date: "2026-12-01", hour: 7 });
    expect(dublinClock(new Date("2026-07-01T23:30:00Z"))).toEqual({ date: "2026-07-02", hour: 0 });
  });
});

describe("error digest (hourly with a daily guard)", () => {
  const nineAmDublin = new Date("2026-09-30T08:00:00Z");

  it("does nothing before 08:00 Dublin time", async () => {
    await errorDigestJob(new Date("2026-09-30T06:30:00Z"));
    expect(db.claimJobRun).not.toHaveBeenCalled();
  });

  it("sends once per Dublin day, catching up on the first run after 08:00", async () => {
    db.claimJobRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    db.errorDigest.mockResolvedValue([
      {
        fingerprint: "a".repeat(64),
        source: "server",
        message: "TypeError: boom",
        route: "/o/:id",
        occurrences: 3,
        status: "new",
        first_seen_at: new Date(),
        last_seen_at: new Date(),
      },
    ]);
    await errorDigestJob(nineAmDublin);
    await errorDigestJob(new Date("2026-09-30T09:00:00Z"));
    expect(db.claimJobRun).toHaveBeenCalledWith("error-digest", "2026-09-30");
    expect(sendAlertEmail).toHaveBeenCalledOnce();
    expect(sendAlertEmail.mock.calls[0]![1]).toContain("3x [server] /o/:id  TypeError: boom");
  });

  it("sends no email when there are no open errors", async () => {
    db.claimJobRun.mockResolvedValue(true);
    db.errorDigest.mockResolvedValue([]);
    await errorDigestJob(nineAmDublin);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });
});

describe("error prune", () => {
  it("prunes 90-day-old errors once per Dublin day", async () => {
    db.claimJobRun.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await errorPrune(new Date("2026-09-30T01:00:00Z"));
    await errorPrune(new Date("2026-09-30T02:00:00Z"));
    expect(db.pruneErrorEvents).toHaveBeenCalledOnce();
    expect(db.pruneErrorEvents).toHaveBeenCalledWith(90);
  });
});
