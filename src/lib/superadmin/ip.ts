import { isIP } from "node:net";

/**
 * The /superadmin IP allowlist. Pure: no environment or header access here, so both the proxy and
 * the page guard share it and it can be unit tested. FAIL CLOSED: an empty or unreadable list
 * allows nobody, and an entry that cannot be parsed is dropped (never widened).
 *
 * Entries are comma-separated: exact IPv4/IPv6 addresses, or IPv4 CIDR ranges like 203.0.113.0/24.
 */
type Rule = { kind: "exact"; ip: string } | { kind: "cidr4"; base: number; mask: number };

function ipv4ToInt(ip: string): number | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function normalise(ip: string): string {
  const lower = ip.trim().toLowerCase();
  // An IPv4 address that arrives IPv4-mapped (::ffff:1.2.3.4) is the same address.
  if (lower.startsWith("::ffff:") && isIP(lower.slice(7)) === 4) return lower.slice(7);
  if (isIP(lower) === 6) {
    // One spelling per IPv6 address, so 2001:db8::1 equals 2001:db8:0:0:0:0:0:1 (and the hex
    // IPv4-mapped form ::ffff:7f00:1 becomes its IPv4 address).
    try {
      const host = new URL(`http://[${lower}]`).hostname.slice(1, -1);
      const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
      if (mapped) {
        const hi = parseInt(mapped[1]!, 16);
        const lo = parseInt(mapped[2]!, 16);
        return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
      }
      return host;
    } catch {
      return lower;
    }
  }
  return lower;
}

export function parseAllowlist(raw: string | undefined): Rule[] {
  if (!raw) return [];
  const rules: Rule[] = [];
  for (const entry of raw.split(",")) {
    const e = entry.trim();
    if (!e) continue;
    const slash = e.indexOf("/");
    if (slash === -1) {
      const ip = normalise(e);
      if (isIP(ip) !== 0) rules.push({ kind: "exact", ip });
      continue;
    }
    const base = ipv4ToInt(e.slice(0, slash));
    const bits = Number(e.slice(slash + 1));
    // /0 would allow the whole internet: refuse it rather than honour it.
    if (base === null || !Number.isInteger(bits) || bits < 1 || bits > 32) continue;
    const mask = bits === 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
    rules.push({ kind: "cidr4", base: (base & mask) >>> 0, mask });
  }
  return rules;
}

export function ipAllowed(ip: string | null | undefined, rules: Rule[]): boolean {
  if (!ip || rules.length === 0) return false;
  const addr = normalise(ip);
  if (isIP(addr) === 0) return false; // "unknown" and junk never match
  const asInt = ipv4ToInt(addr);
  return rules.some((r) =>
    r.kind === "exact" ? r.ip === addr : asInt !== null && (asInt & r.mask) >>> 0 === r.base,
  );
}

/** The caller IP: X-Real-IP, else the LAST X-Forwarded-For entry (the first is client-controlled). */
export function callerIp(h: Headers): string | null {
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",").at(-1)?.trim() || null;
}

/** Reads SUPERADMIN_IP_ALLOWLIST. Unset or empty = nobody may reach /superadmin. */
export function superadminIpAllowed(
  h: Headers,
  raw = process.env.SUPERADMIN_IP_ALLOWLIST,
): boolean {
  return ipAllowed(callerIp(h), parseAllowlist(raw));
}
