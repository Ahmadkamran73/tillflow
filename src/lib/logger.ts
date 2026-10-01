import "server-only";
import pino from "pino";

/**
 * Structured JSON logs to stdout (Hostinger keeps the app's output). Never pass personal data:
 * log ids, codes and counts only. Anything built from user input goes through
 * src/lib/errors/scrub first.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "test" ? "silent" : "info"), // LOG_LEVEL=debug|info|warn|error
  base: { env: process.env.NEXT_PUBLIC_APP_ENV ?? "development" },
  redact: {
    paths: [
      "email",
      "name",
      "phone",
      "password",
      "token",
      "pin",
      "*.email",
      "*.name",
      "*.phone",
      "*.password",
      "*.token",
      "*.pin",
      "*.body",
      "*.authorization",
      "*.cookie",
      "*.headers.authorization",
      "*.headers.cookie",
    ],
    censor: "[redacted]",
  },
});
