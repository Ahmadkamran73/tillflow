"use server";

import { redirect } from "next/navigation";
import { clearDeviceToken } from "@/lib/device/cookie";

/**
 * Lets this browser be paired to a different business. It only forgets the till on THIS browser; the
 * till stays registered for its business until a manager revokes it in Settings, Tills.
 */
export async function forgetThisTill() {
  await clearDeviceToken();
  redirect("/register/pair");
}
