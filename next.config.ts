import { execSync } from "node:child_process";
import withSerwistInit from "@serwist/next";
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

// The register service worker (src/sw/sw.ts): precaches the build and finishes sending the sale
// outbox in the background. Only built by `next build --webpack`; off in `next dev`.
const withSerwist = withSerwistInit({
  swSrc: "src/sw/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV !== "production",
  reloadOnOnline: false,
});

const nextConfig: NextConfig = {
  // `next dev` runs Turbopack, which ignores the webpack-only Serwist plugin; say so explicitly.
  turbopack: {},
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }],
      },
    ];
  },
  // Loaded at runtime from node_modules, not bundled (pg and pino are external by default).
  serverExternalPackages: ["pg-boss"],
  // Off on Hostinger, so maps are never served. CI sets SOURCE_MAPS=true in the source-maps
  // workflow to keep a private copy per commit (docs/DEPLOY.md "Reading a browser stack trace").
  productionBrowserSourceMaps: process.env.SOURCE_MAPS === "true",
  // Inlined at build time; read by /api/health.
  env: {
    APP_VERSION: pkg.version,
    APP_COMMIT: commitSha(),
  },
};

export default withSerwist(nextConfig);
