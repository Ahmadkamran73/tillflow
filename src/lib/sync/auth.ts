import "server-only";
import { authenticateDevice } from "@/lib/device/auth";

export type RegisterAuth =
  | { ok: true; orgId: string; registerId: string; tokenHash: string }
  | { ok: false; status: 401 | 403 | 404 };

/**
 * Who is syncing, and for which till: a paired device, identified by its token. The till named in
 * the request must be the till the token belongs to; the shop always comes from the token, never
 * from the URL or the payload (`orgId` is only checked against it).
 */
export async function authenticateRegister(
  orgId: string,
  registerId: string,
): Promise<RegisterAuth> {
  const device = await authenticateDevice(orgId);
  if (!device.ok) return device;
  if (device.registerId !== registerId) return { ok: false, status: 403 };
  return {
    ok: true,
    orgId: device.orgId,
    registerId: device.registerId,
    tokenHash: device.tokenHash,
  };
}
