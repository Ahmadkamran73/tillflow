import * as Sentry from "@sentry/nextjs";
import { sentryBaseOptions } from "@/lib/observability/scrub";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
if (dsn) {
  Sentry.init({ ...sentryBaseOptions, dsn, integrations: [] });
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
