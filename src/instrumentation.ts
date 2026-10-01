import type { Instrumentation } from "next";

/** Starts the pg-boss worker once per Node.js server process (not in the edge runtime). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.JOBS_ENABLED === "false") return;
  const { startJobs } = await import("@/lib/jobs");
  void startJobs(); // don't hold up the server: /api/health shows "jobs" once it is running
}

/** Server errors from pages, route handlers, server actions and the proxy land in error_events. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    console.error("request error in the edge runtime", context.routeType);
    return;
  }
  const { reportError } = await import("@/lib/errors");
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String(error.digest)
      : undefined;
  await reportError(error, {
    source: "server",
    route: request.path,
    context: { method: request.method, routeType: context.routeType, digest },
  });
};
