// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, expect, it, vi } from "vitest";

const reportError = vi.fn();
vi.mock("@/lib/errors", () => ({ reportError }));

const { POST } = await import("@/app/api/log-error/route");

const request = (body: string, headers: Record<string, string> = {}) =>
  new NextRequest("https://staging.tillflow.ie/api/log-error", {
    method: "POST",
    body,
    headers: {
      origin: "https://staging.tillflow.ie",
      "x-forwarded-for": "10.0.0.1",
      "content-length": String(Buffer.byteLength(body)),
      ...headers,
    },
  });

beforeEach(() => {
  reportError.mockReset();
});

it("accepts a same-origin report and passes it on as a browser error", async () => {
  const res = await POST(request(JSON.stringify({ message: "boom", route: "/o/x?y=1" })));
  expect(res.status).toBe(204);
  expect(reportError).toHaveBeenCalledOnce();
  const [error, report] = reportError.mock.calls[0]!;
  expect((error as Error).message).toBe("boom");
  expect(report).toMatchObject({ source: "browser", route: "/o/x?y=1" });
});

it("refuses other origins and requests without an origin", async () => {
  expect((await POST(request("{}", { origin: "https://evil.example" }))).status).toBe(403);
  const noOrigin = new NextRequest("https://staging.tillflow.ie/api/log-error", {
    method: "POST",
    body: JSON.stringify({ message: "x" }),
  });
  expect((await POST(noOrigin)).status).toBe(403);
  expect(reportError).not.toHaveBeenCalled();
});

it("refuses a body without a Content-Length", async () => {
  const res = await POST(
    new NextRequest("https://staging.tillflow.ie/api/log-error", {
      method: "POST",
      body: JSON.stringify({ message: "x" }),
      headers: { origin: "https://staging.tillflow.ie", "x-forwarded-for": "10.0.0.2" },
    }),
  );
  expect(res.status).toBe(411);
});

it("refuses bodies over 8 KB and invalid input", async () => {
  expect((await POST(request(JSON.stringify({ message: "x".repeat(9000) })))).status).toBe(413);
  expect((await POST(request("not json"))).status).toBe(400);
  expect((await POST(request(JSON.stringify({ message: "" })))).status).toBe(400);
  expect(reportError).not.toHaveBeenCalled();
});

it("rate limits a flood from one IP to 30 a minute", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 35; i++) {
    const res = await POST(
      request(JSON.stringify({ message: `m${i}` }), { "x-forwarded-for": "10.9.9.9" }),
    );
    statuses.push(res.status);
  }
  expect(statuses.filter((s) => s === 204)).toHaveLength(30);
  expect(statuses.filter((s) => s === 429)).toHaveLength(5);
});
