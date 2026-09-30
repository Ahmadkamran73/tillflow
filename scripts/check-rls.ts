/**
 * Fails (exit 1) if any table in the public schema lacks row level security,
 * or has RLS enabled but no policy at all.
 *
 * Usage:
 *   pnpm check:rls                       # local DB (DIRECT_URL from .env.local)
 *   pnpm check:rls --url-env=SOME_VAR    # read the connection string from another env var
 *
 * Runs in a READ ONLY transaction, so it is safe against staging.
 */
import { config } from "dotenv";
import postgres from "postgres";

config({ path: ".env.local", quiet: true });

const urlEnv = process.argv.find((a) => a.startsWith("--url-env="))?.split("=")[1] ?? "DIRECT_URL";
const url = process.env[urlEnv];
if (!url) {
  console.error(`check-rls: ${urlEnv} is not set`);
  process.exit(1);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  try {
    const rows = await sql.begin(
      "read only",
      (tx) =>
        tx<{ table: string; rls: boolean; policies: number }[]>`
      select c.relname as table,
             c.relrowsecurity as rls,
             (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
      order by c.relname`,
    );

    const problems = rows.flatMap((r) => [
      ...(r.rls ? [] : [`${r.table}: row level security is NOT enabled`]),
      ...(r.rls && r.policies === 0
        ? [`${r.table}: RLS enabled but no policy (nobody can read it)`]
        : []),
    ]);

    if (rows.length === 0) problems.push("no public tables found; wrong database?");

    if (problems.length > 0) {
      console.error("check-rls FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
      process.exitCode = 1;
    } else {
      console.log(
        `check-rls OK: ${rows.length} public tables, all with RLS and at least one policy`,
      );
    }
  } finally {
    await sql.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
