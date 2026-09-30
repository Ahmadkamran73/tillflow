import type { ErrorEvent } from "@sentry/nextjs";

const SENSITIVE_KEY =
  /pass|secret|token|authorization|cookie|api[-_]?key|pin|email|phone|name|address|eircode|vat/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.replace(EMAIL, "[email]");
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      SENSITIVE_KEY.test(k) ? "[redacted]" : scrubValue(v, depth + 1),
    ]),
  );
}

/** Sentry beforeSend: strips personal data (PLAN §10, CLAUDE.md "never log personal data"). */
export function scrubEvent<T extends ErrorEvent>(event: T): T {
  delete event.user;
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.query_string;
    event.request.headers = scrubValue(event.request.headers) as Record<string, string>;
  }
  if (event.extra) event.extra = scrubValue(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrubValue(event.contexts) as typeof event.contexts;
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      message: typeof b.message === "string" ? (scrubValue(b.message) as string) : b.message,
      data: b.data ? (scrubValue(b.data) as typeof b.data) : b.data,
    }));
  }
  if (event.message) event.message = scrubValue(event.message) as string;
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubValue(ex.value) as string;
  }
  return event;
}

/** Shared Sentry options: no default PII, no IP, scrubbed events. */
export const sentryBaseOptions = {
  sendDefaultPii: false,
  tracesSampleRate: 0.1,
  environment: process.env.NEXT_PUBLIC_APP_ENV ?? "development",
  release: process.env.APP_COMMIT,
  beforeSend: scrubEvent,
};
