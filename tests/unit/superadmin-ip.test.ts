import { describe, expect, it } from "vitest";
import { callerIp, ipAllowed, parseAllowlist, superadminIpAllowed } from "@/lib/superadmin/ip";

const allow = (raw: string | undefined, ip: string | null) => ipAllowed(ip, parseAllowlist(raw));

describe("superadmin IP allowlist", () => {
  it("fails closed when unset, empty or unreadable", () => {
    expect(allow(undefined, "203.0.113.5")).toBe(false);
    expect(allow("", "203.0.113.5")).toBe(false);
    expect(allow(" , ,", "203.0.113.5")).toBe(false);
    expect(allow("not-an-ip", "203.0.113.5")).toBe(false);
  });

  it("matches exact IPv4 and IPv6, ignoring spaces and case", () => {
    expect(allow("203.0.113.5", "203.0.113.5")).toBe(true);
    expect(allow(" 198.51.100.1 , 203.0.113.5 ", "203.0.113.5")).toBe(true);
    expect(allow("203.0.113.5", "203.0.113.6")).toBe(false);
    expect(allow("2001:DB8::1", "2001:db8::1")).toBe(true);
    expect(allow("2001:db8::1", "2001:db8::2")).toBe(false);
  });

  it("treats an IPv4-mapped IPv6 address as the IPv4 address", () => {
    expect(allow("203.0.113.5", "::ffff:203.0.113.5")).toBe(true);
  });

  it("compares IPv6 addresses by value, not spelling", () => {
    expect(allow("2001:db8::1", "2001:db8:0:0:0:0:0:1")).toBe(true);
    expect(allow("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::1")).toBe(true);
    expect(allow("127.0.0.1", "::ffff:7f00:1")).toBe(true);
    expect(allow("2001:db8::1", "2001:db8::10")).toBe(false);
  });

  it("matches IPv4 CIDR ranges at their edges", () => {
    expect(allow("203.0.113.0/24", "203.0.113.0")).toBe(true);
    expect(allow("203.0.113.0/24", "203.0.113.255")).toBe(true);
    expect(allow("203.0.113.0/24", "203.0.114.0")).toBe(false);
    expect(allow("203.0.113.7/32", "203.0.113.7")).toBe(true);
    expect(allow("203.0.113.7/32", "203.0.113.8")).toBe(false);
  });

  it("refuses /0 and malformed ranges instead of widening them", () => {
    expect(allow("0.0.0.0/0", "203.0.113.5")).toBe(false);
    expect(allow("203.0.113.0/33", "203.0.113.5")).toBe(false);
    expect(allow("203.0.113.0/x", "203.0.113.5")).toBe(false);
    expect(allow("999.0.0.1", "999.0.0.1")).toBe(false);
  });

  it("never matches a missing or unknown caller", () => {
    expect(allow("203.0.113.5", null)).toBe(false);
    expect(allow("203.0.113.5", "unknown")).toBe(false);
    expect(allow("203.0.113.5", "")).toBe(false);
  });

  it("reads the caller from X-Real-IP, else the LAST X-Forwarded-For entry", () => {
    expect(callerIp(new Headers({ "x-real-ip": "203.0.113.5" }))).toBe("203.0.113.5");
    // A spoofed first entry must not be believed.
    const spoof = new Headers({ "x-forwarded-for": "203.0.113.5, 198.51.100.9" });
    expect(callerIp(spoof)).toBe("198.51.100.9");
    expect(superadminIpAllowed(spoof, "203.0.113.5")).toBe(false);
    expect(superadminIpAllowed(new Headers(), "203.0.113.5")).toBe(false);
  });
});
