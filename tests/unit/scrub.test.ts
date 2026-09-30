import type { ErrorEvent } from "@sentry/nextjs";
import { expect, it } from "vitest";
import { scrubEvent } from "@/lib/observability/scrub";

it("removes personal data from events", () => {
  const event = {
    type: undefined,
    user: { email: "a@b.ie", ip_address: "1.2.3.4" },
    message: "failed for owner@shop.ie",
    request: {
      cookies: { sb: "x" },
      data: { pin: "1234" },
      headers: { authorization: "Bearer t", accept: "*/*" },
    },
    extra: { customerName: "Mary", count: 2 },
  } as unknown as ErrorEvent;
  const out = scrubEvent(event);
  expect(out.user).toBeUndefined();
  expect(out.message).toBe("failed for [email]");
  expect(out.request?.data).toBeUndefined();
  expect(out.request?.headers).toEqual({ authorization: "[redacted]", accept: "*/*" });
  expect(out.extra).toEqual({ customerName: "[redacted]", count: 2 });
});
