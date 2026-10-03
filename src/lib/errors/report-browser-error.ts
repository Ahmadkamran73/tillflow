/**
 * Sends a browser error to /api/log-error (same origin). Fire-and-forget, never throws, and at
 * most 10 reports per page load so a render loop cannot flood the endpoint. The server scrubs
 * everything; the client only trims and drops the query string.
 */
let sent = 0;
const MAX_PER_PAGE = 10;

export function reportBrowserError(error: unknown, digest?: string): void {
  try {
    if (sent >= MAX_PER_PAGE || typeof window === "undefined") return;
    sent += 1;
    const e = error instanceof Error ? error : new Error(String(error));
    const body = JSON.stringify({
      name: e.name.slice(0, 100),
      message: (e.message || "Unknown error").slice(0, 1000),
      stack: e.stack?.slice(0, 6000),
      route: window.location.pathname.slice(0, 300),
      digest: digest?.slice(0, 100),
    });
    void fetch("/api/log-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      keepalive: true,
    }).catch(() => {});
  } catch {
    // never throw from the reporter
  }
}
