import "server-only";
import { cookies } from "next/headers";
import { looksLikeDeviceToken } from "./token";

/**
 * The till's device token lives in an httpOnly, SameSite=Strict cookie: page script cannot read it
 * and other sites cannot make the browser send it. Over HTTPS it is a `__Host-` cookie (Secure,
 * no Domain, path /), which a sibling subdomain cannot overwrite.
 */
const secure = (process.env.NEXT_PUBLIC_APP_URL ?? "").startsWith("https://");
export const DEVICE_COOKIE = secure ? "__Host-tf_device" : "tf_device";
const MAX_AGE_SECONDS = 400 * 24 * 60 * 60; // the longest a browser will keep a cookie

export async function readDeviceToken(): Promise<string | null> {
  const value = (await cookies()).get(DEVICE_COOKIE)?.value;
  return looksLikeDeviceToken(value) ? value : null;
}

/** Route handlers and server actions only. Also used to refresh the expiry on every sync. */
export async function setDeviceToken(token: string): Promise<void> {
  (await cookies()).set(DEVICE_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "strict",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function clearDeviceToken(): Promise<void> {
  (await cookies()).delete(DEVICE_COOKIE);
}
