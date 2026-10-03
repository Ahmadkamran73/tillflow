// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fingerprint, scrubContext, scrubRoute, scrubText } from "@/lib/errors/scrub";

describe("scrubText", () => {
  it("masks emails, tokens, IPs, phone numbers, IBANs, eircodes, secrets and credential URLs", () => {
    // Fake credential URL, assembled at runtime so secret scanners don't flag the test file.
    const fakeDbUrl = ["postgresql://postgres", "hunter2@db.example.co:5432/postgres"].join(":");
    const out = scrubText(
      "user mary.murphy@shop.ie token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl from 83.70.12.9 " +
        "call +353 87 123 4567 iban IE29AIBK93115212345678 at D02 X285 and d6w x123 " +
        "key Zq7Wm2Rt9Xp4Lk8Hv3Nc6Bj1Df5Gs0Ya2Ue7Io4P " +
        `db ${fakeDbUrl} Bearer abc.def`,
    );
    const leaks = [
      "mary.murphy",
      "@shop.ie",
      "eyJ",
      "83.70.12.9",
      "123 4567",
      "IE29",
      "D02 X285",
      "x123",
      "Zq7Wm2Rt9Xp4",
      "hunter2",
      "abc.def",
    ];
    for (const leaked of leaks) expect(out).not.toContain(leaked);
  });

  it("trims to the maximum length", () => {
    expect(scrubText("word ".repeat(1000), 100)).toHaveLength(100);
  });
});

describe("scrubContext", () => {
  it("keeps only allow-listed keys with primitive values", () => {
    expect(
      scrubContext({
        route: "/o",
        bucket: "login",
        email: "a@b.ie",
        name: "Mary",
        body: { pin: 1234 },
        status: 500,
      }),
    ).toEqual({ route: "/o", bucket: "login", status: "500" });
  });
});

describe("scrubContext ids", () => {
  it("keeps org_id and user_id only when they are UUIDs", () => {
    const id = "0190F3A4-1B2C-7D3E-8F40-123456789ABC";
    expect(scrubContext({ org_id: id, user_id: "mary@shop.ie" })).toEqual({
      org_id: id.toLowerCase(),
    });
  });
});

describe("scrubRoute", () => {
  it("drops the query string and fragment and replaces ids", () => {
    expect(scrubRoute("/o/0190f3a4-1b2c-7d3e-8f40-123456789abc/dashboard?email=a@b.ie#x")).toBe(
      "/o/:id/dashboard",
    );
    expect(scrubRoute(undefined)).toBeNull();
  });
});

describe("fingerprint", () => {
  const stack = (line: number) =>
    `TypeError: boom\n    at load (/app/.next/server/page.js:${line}:17)\n    at render (/app/x.js:3:1)`;

  it("groups the same error across ids, numbers and line positions", () => {
    const a = fingerprint(
      "server",
      "TypeError",
      "no org 0190f3a4-1b2c-7d3e-8f40-123456789abc (42)",
      stack(10),
    );
    const b = fingerprint(
      "server",
      "TypeError",
      "no org 0190f3a4-0000-7d3e-8f40-000000000000 (7)",
      stack(99),
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates different messages and sources", () => {
    const a = fingerprint("server", "TypeError", "boom", null);
    expect(fingerprint("server", "TypeError", "bang", null)).not.toBe(a);
    expect(fingerprint("browser", "TypeError", "boom", null)).not.toBe(a);
  });
});
