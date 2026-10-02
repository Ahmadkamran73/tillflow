import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { appUrl } from "@/lib/auth/config";
import { reportError } from "@/lib/errors";
import { ipFromHeaders, memoryRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Browser error reports (src/components/error-reporter.tsx). Public but narrow: same-origin only,
 * 8 KB max, Zod-validated, 30 reports per minute per IP (in memory, per process), and everything is scrubbed
 * by reportError before it is logged or stored. Always answers 204 so it gives nothing away.
 */

const MAX_BYTES = 8 * 1024;

const browserError = z.object({
  name: z.string().max(100).default("Error"),
  message: z.string().min(1).max(1000),
  stack: z.string().max(6000).optional(),
  route: z.string().max(300).optional(),
  digest: z.string().max(100).optional(),
});

const noContent = () => new NextResponse(null, { status: 204 });

function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    // Behind Hostinger's proxy nextUrl carries the internal host, so also accept the app's own URL.
    const host = new URL(origin).host;
    return host === new URL(appUrl()).host || host === request.nextUrl.host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!sameOrigin(request)) return new NextResponse(null, { status: 403 });

    const ip = ipFromHeaders(request.headers);
    if (!memoryRateLimit("log-error", ip, 30, 60_000))
      return new NextResponse(null, { status: 429 });

    // Browsers always send Content-Length for this fetch; refuse streamed bodies of unknown size
    // so nothing large is ever buffered.
    const length = Number(request.headers.get("content-length") ?? "NaN");
    if (!Number.isFinite(length)) return new NextResponse(null, { status: 411 });
    if (length > MAX_BYTES) return new NextResponse(null, { status: 413 });
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_BYTES) return new NextResponse(null, { status: 413 });

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return new NextResponse(null, { status: 400 });
    }
    const parsed = browserError.safeParse(json);
    if (!parsed.success) return new NextResponse(null, { status: 400 });

    const { name, message, stack, route, digest } = parsed.data;
    const error = Object.assign(new Error(message), { name, stack: stack ?? "" });
    await reportError(error, {
      source: "browser",
      route,
      context: { digest },
    });
    return noContent();
  } catch {
    return noContent();
  }
}
