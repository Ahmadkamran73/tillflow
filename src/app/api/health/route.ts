import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Uptime probe. Public on purpose; it reveals only the version and commit, never config or data. */
export function GET() {
  return NextResponse.json(
    {
      status: "ok",
      version: process.env.APP_VERSION ?? "unknown",
      commit: process.env.APP_COMMIT ?? "unknown",
      environment: process.env.NEXT_PUBLIC_APP_ENV ?? "unknown",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
