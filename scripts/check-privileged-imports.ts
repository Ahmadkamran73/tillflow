/**
 * Fails (exit 1) if privileged database access appears outside the files allowed to have it
 * (.claude/claude-security-guidance.md: "service role only in src/lib/ops/db.ts and the pg-boss
 * job handlers"). Runs in CI next to lint.
 *
 *   @/lib/ops/db              privileged module (RLS-bypassing connection, ops.* functions only)
 *   pg-boss                   job queue (same connection)
 *   postgres / pg / drizzle   raw clients connect as the table owner and bypass RLS
 *   JOBS_DATABASE_URL, DATABASE_URL, DIRECT_URL   owner connection strings
 *   SUPABASE_SERVICE_ROLE_KEY / service_role
 *
 * Usage: pnpm check:imports
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const Q = "[\"'`]";

/** Any import form: import/export ... from, side-effect import, dynamic import(), require(). */
function anyImport(module: string): RegExp {
  const m = `${Q}${module}${Q}`;
  return new RegExp(`\\bfrom\\s+${m}|\\bimport\\s*\\(?\\s*${m}|\\brequire\\s*\\(\\s*${m}`);
}

const RULES: { name: string; pattern: RegExp; allowed: string[] }[] = [
  {
    name: "@/lib/ops/db (privileged database module)",
    pattern: anyImport("(?:@/|(?:\\.\\.?/)+|src/)(?:lib/)?ops/db(?:\\.ts)?"),
    allowed: [
      "src/lib/errors/index.ts",
      "src/lib/rate-limit/index.ts",
      "src/lib/sync/server.ts",
      "src/lib/device/", // device-token auth, pairing, PIN attempts, till feed and events
      "src/lib/jobs/handlers/", // every pg-boss job handler
      "src/app/api/health/route.ts",
    ],
  },
  {
    name: "pg-boss",
    pattern: anyImport("pg-boss"),
    allowed: ["src/lib/jobs/boss.ts", "src/lib/jobs/index.ts"],
  },
  {
    name: "raw database client (postgres, pg, drizzle-orm/postgres-js, drizzle-orm/node-postgres)",
    pattern: anyImport("(?:postgres|pg|drizzle-orm/postgres-js|drizzle-orm/node-postgres)"),
    allowed: ["src/lib/ops/db.ts"],
  },
  {
    name: "JOBS_DATABASE_URL",
    pattern: /\bJOBS_DATABASE_URL\b/,
    allowed: ["src/lib/ops/db.ts", "src/lib/jobs/index.ts"],
  },
  {
    name: "DATABASE_URL / DIRECT_URL (owner connection strings)",
    pattern: /(?<!JOBS_)\b(?:DATABASE_URL|DIRECT_URL)\b/,
    allowed: [], // add the RLS-scoped src/db client here when it exists
  },
  {
    name: "service-role key",
    pattern: /SUPABASE_SERVICE_ROLE_KEY|["'`]service_role["'`]/,
    allowed: ["src/lib/ops/db.ts"],
  },
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry) ? [path] : [];
  });
}

const files = walk("src").map((f) => relative(".", f).split(sep).join("/"));
const problems: string[] = [];

for (const file of files) {
  const code = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "") // comments may mention the names
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const rule of RULES) {
    const allowed = rule.allowed.some((a) => (a.endsWith("/") ? file.startsWith(a) : file === a));
    if (rule.pattern.test(code) && !allowed) {
      problems.push(
        `${file}: uses ${rule.name}; only ${rule.allowed.join(", ") || "no file in src"} may`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error("check-privileged-imports FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`check-privileged-imports OK: ${files.length} files checked`);
}
