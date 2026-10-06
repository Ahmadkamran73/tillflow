import "server-only";
import { deviceAuth, type DeviceContext } from "@/lib/ops/db";
import { readDeviceToken } from "./cookie";
import { hashDeviceToken } from "./token";

export type DeviceAuth =
  ({ ok: true; tokenHash: string } & DeviceContext) | { ok: false; status: 401 | 404 };

/**
 * Who is calling, as a paired till. 401 when there is no token, or it was revoked, replaced or
 * belongs to a closed shop. When `orgId` is given and the till belongs to a different shop the
 * answer is 404, exactly like a shop that does not exist.
 */
export async function authenticateDevice(orgId?: string): Promise<DeviceAuth> {
  const token = await readDeviceToken();
  if (!token) return { ok: false, status: 401 };
  const tokenHash = hashDeviceToken(token);
  const ctx = await deviceAuth(tokenHash);
  if (!ctx) return { ok: false, status: 401 };
  if (orgId !== undefined && ctx.orgId !== orgId) return { ok: false, status: 404 };
  return { ok: true, tokenHash, ...ctx };
}
