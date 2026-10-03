// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";

const recordError = vi.fn();
const sendAlertEmail = vi.fn();
vi.mock("@/lib/ops/db", () => ({ recordError }));
vi.mock("@/lib/errors/alert", () => ({ sendAlertEmail }));

const { reportError } = await import("@/lib/errors");

beforeEach(() => {
  recordError.mockReset();
  sendAlertEmail.mockReset();
});

it("stores a scrubbed error and alerts when the database says it is new", async () => {
  recordError.mockResolvedValue({ isNew: true, shouldAlert: true, occurrences: 1 });
  await reportError(new Error("lookup failed for owner@shop.ie"), {
    source: "server",
    route: "/login?email=owner@shop.ie",
    context: { method: "POST", email: "owner@shop.ie" },
  });
  const stored = recordError.mock.calls[0]![0];
  expect(stored).toMatchObject({ source: "server", route: "/login" });
  expect(stored.message).toBe("Error: lookup failed for [email]");
  expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect(sendAlertEmail).toHaveBeenCalledOnce();
  const [subject, text] = sendAlertEmail.mock.calls[0]!;
  expect(`${subject}\n${text}`).not.toMatch(/owner@|shop\.ie/);
});

it("does not alert for a known fingerprint", async () => {
  recordError.mockResolvedValue({ isNew: false, shouldAlert: false, occurrences: 5 });
  await reportError(new Error("again"), { source: "job" });
  expect(sendAlertEmail).not.toHaveBeenCalled();
});

it("never throws, even when the database is down or the value is not an Error", async () => {
  recordError.mockRejectedValue(new Error("connection refused"));
  await expect(reportError("plain string", { source: "browser" })).resolves.toBeUndefined();
  await expect(reportError(null, { source: "server" })).resolves.toBeUndefined();
  expect(sendAlertEmail).not.toHaveBeenCalled();
});
