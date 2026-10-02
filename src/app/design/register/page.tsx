import type { Metadata } from "next";
import { RegisterDemo } from "@/components/register/register-demo";
import type { SyncState } from "@/components/sync-status-pill";

export const metadata: Metadata = { title: "Register layout", robots: { index: false } };

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  const s: SyncState = state === "offline" || state === "syncing" ? state : "online";
  return <RegisterDemo state={s} />;
}
