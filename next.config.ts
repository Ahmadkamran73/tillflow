import { execSync } from "node:child_process";
import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import pkg from "./package.json";

function commitSha() {
  const fromEnv = process.env.GITHUB_SHA ?? process.env.COMMIT_SHA;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown"; // host built without git history
  }
}

const nextConfig: NextConfig = {
  // Inlined at build time; read by /api/health and Sentry.
  env: {
    APP_VERSION: pkg.version,
    APP_COMMIT: commitSha(),
  },
};

export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  // Source maps upload only when a token is present (Hostinger/production builds).
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  telemetry: false,
  widenClientFileUpload: true,
});
