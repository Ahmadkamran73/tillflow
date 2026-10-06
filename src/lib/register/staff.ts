import { verifyPin } from "@/lib/auth/pin";
import type { RegisterDb } from "./db";
import type { Feed } from "./feed";

export type StaffMember = Feed["staff"][number];
export type Role = StaffMember["role"];
/** unlock: a cashier starts serving. override: a manager or owner approves one action. */
export type PinPurpose = "unlock" | "override";

/** What a manager's PIN is being used to approve. */
export type ApprovalFor = "discount" | "no_sale" | "refund";

export type PinResult =
  /** `approvalId`: the server's single-use proof of a manager PIN (online overrides only). */
  | { status: "ok"; userId: string; role: Role; approvalId?: string }
  | { status: "invalid" }
  | { status: "locked"; lockedUntil: number }
  /** The PIN was right but belongs to someone who may not approve (a cashier asked to override). */
  | { status: "not_allowed" }
  /** This device's token was revoked or is gone: pair the till again. */
  | { status: "unpaired" }
  /** Too many checks from this till in a short time. */
  | { status: "limited" };

/** Five failures lock that person for 15 minutes (the server's rule, mirrored here for offline use). */
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60_000;

export const canApprove = (role: Role) => role === "owner" || role === "manager";

type Deps = { fetchFn?: typeof fetch; now?: () => number; approvalFor?: ApprovalFor };

const unlockResponse = (raw: unknown): PinResult | null => {
  const r = raw as {
    result?: string;
    userId?: string;
    role?: Role;
    lockedUntil?: string;
    approvalId?: string;
  } | null;
  switch (r?.result) {
    case "ok":
      return r.userId && r.role
        ? { status: "ok", userId: r.userId, role: r.role, approvalId: r.approvalId }
        : null;
    case "invalid":
      return { status: "invalid" };
    case "not_allowed":
      return { status: "not_allowed" };
    case "locked": {
      const until = r.lockedUntil ? new Date(r.lockedUntil).getTime() : NaN;
      return Number.isFinite(until) ? { status: "locked", lockedUntil: until } : null;
    }
    default:
      return null;
  }
};

/** The server's answer, or null when it cannot be reached (offline, or it is failing): fall back to the cache. */
async function checkOnline(
  userId: string,
  pin: string,
  purpose: PinPurpose,
  fetchFn: typeof fetch,
  approvalFor?: ApprovalFor,
): Promise<PinResult | null> {
  let res: Response;
  try {
    res = await fetchFn("/api/v1/register/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({
        userId,
        pin,
        purpose,
        approvalFor: purpose === "override" ? approvalFor : undefined,
      }),
    });
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403) return { status: "unpaired" };
  if (res.status === 429) return { status: "limited" };
  if (!res.ok) return null;
  try {
    return unlockResponse(await res.json());
  } catch {
    return null;
  }
}

/**
 * Checks one person's PIN. Online, the server decides (its database counters are the real lockout);
 * if it cannot be reached the PIN is checked against the Argon2 hash cached from the last catalogue
 * pull. Failures are counted on the device either way and a server lock is remembered here, so
 * going offline never buys more guesses. An attempt is counted BEFORE the check, like the server.
 */
export async function checkPin(
  db: RegisterDb,
  member: StaffMember,
  pin: string,
  purpose: PinPurpose,
  { fetchFn = fetch, now = Date.now, approvalFor }: Deps = {},
): Promise<PinResult> {
  const lockOf = async () => {
    const a = await db.pinAttempts.get(member.userId);
    if (a?.lockedUntil && a.lockedUntil > now()) return a.lockedUntil;
    if (a?.lockedUntil) await db.pinAttempts.delete(member.userId); // a spent lock starts a fresh count
    return null;
  };
  const failures = async () => (await db.pinAttempts.get(member.userId))?.failed ?? 0;
  const lockNow = async () => {
    const lockedUntil = now() + LOCK_MS;
    await db.pinAttempts.put({ userId: member.userId, failed: MAX_FAILURES, lockedUntil });
    return { status: "locked", lockedUntil } as const;
  };

  const held = await lockOf();
  if (held) return { status: "locked", lockedUntil: held };

  const online = await checkOnline(member.userId, pin, purpose, fetchFn, approvalFor);
  if (online) {
    if (online.status === "ok" || online.status === "not_allowed") {
      await db.pinAttempts.delete(member.userId);
    } else if (online.status === "invalid") {
      const failed = (await failures()) + 1;
      if (failed >= MAX_FAILURES) return lockNow();
      await db.pinAttempts.put({ userId: member.userId, failed });
    } else if (online.status === "locked") {
      await db.pinAttempts.put({
        userId: member.userId,
        failed: MAX_FAILURES,
        lockedUntil: online.lockedUntil,
      });
    }
    return online;
  }

  // Offline: the cached hash. Reserve the attempt first, then check.
  const failed = (await failures()) + 1;
  if (failed > MAX_FAILURES) return lockNow();
  await db.pinAttempts.put({ userId: member.userId, failed });
  if (await verifyPin(pin, member.pinHash)) {
    await db.pinAttempts.delete(member.userId);
    return purpose === "override" && !canApprove(member.role)
      ? { status: "not_allowed" }
      : { status: "ok", userId: member.userId, role: member.role };
  }
  return failed >= MAX_FAILURES ? lockNow() : { status: "invalid" };
}
