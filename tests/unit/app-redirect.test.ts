// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { appRedirect } from "@/lib/auth/config";

afterEach(() => vi.unstubAllEnvs());

describe("appRedirect", () => {
  it("uses NEXT_PUBLIC_APP_URL, never the request host", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pos.tillflow.ie/");
    const r = appRedirect("/o/abc/settings/export/confirm?next=%2Fo%2Fabc%2Fsettings%2Fexport");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(
      "https://pos.tillflow.ie/o/abc/settings/export/confirm?next=%2Fo%2Fabc%2Fsettings%2Fexport",
    );
  });

  it("falls back to localhost in development", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(appRedirect("/o/x").headers.get("location")).toBe("http://localhost:3000/o/x");
  });

  it("refuses anything that is not an in-app path", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://pos.tillflow.ie");
    expect(() => appRedirect("https://evil.example/x")).toThrow();
    expect(() => appRedirect("//evil.example/x")).toThrow();
    expect(() => appRedirect("evil")).toThrow();
  });
});
