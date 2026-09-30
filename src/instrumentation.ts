import * as Sentry from "@sentry/nextjs";
import { sentryBaseOptions } from "@/lib/observability/scrub";

export function register() {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return; // Sentry is off until a DSN is set
  Sentry.init({ ...sentryBaseOptions, dsn });
}

export const onRequestError = Sentry.captureRequestError;
