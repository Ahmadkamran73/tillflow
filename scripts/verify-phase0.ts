/**
 * Phase 0 exit check: prints PASS/FAIL + evidence per item, exits 1 if anything fails.
 * Never prints env values or secret values, only names. `pnpm verify`; `--quick` skips lint/typecheck/tests.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const quick = process.argv.includes("--quick");
const STAGING_URL = "https://staging.tillflow.ie";
const REQUIRED_SECRETS = ["SUPABASE_ACCESS_TOKEN", "SUPABASE_DB_PASSWORD", "SUPABASE_PROJECT_REF"];

let failed = 0;
function report(ok: boolean, name: string, evidence: string) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${evidence ? ` — ${evidence}` : ""}`);
}
function run(cmd: string) {
  const r = spawnSync(cmd, { shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
const lastLine = (s: string) => s.split(/\r?\n/).filter(Boolean).pop() ?? "";
const summary = (s: string) =>
  s.split(/\r?\n/).reverse().find((l) => /Tests\s+\d|OK|error/.test(l))?.trim() ?? lastLine(s);
const gh = (args: string) => run(`gh ${args}`);

async function main() {
  // 1. tools
  const tools: [string, string, number][] = [
    ["node", "node -v", 22],
    ["pnpm", "pnpm -v", 10],
    ["git", "git --version", 2],
    ["gh", "gh --version", 2],
    ["docker", "docker --version", 20],
    ["supabase CLI", "pnpm exec supabase --version", 2],
  ];
  for (const [name, cmd, min] of tools) {
    const r = run(cmd);
    const v = r.out.match(/\d+(\.\d+)+/)?.[0];
    report(
      r.ok && !!v && parseInt(v) >= min,
      `tool: ${name}`,
      r.ok ? `v${v} (need >= ${min})` : "not found",
    );
  }

  // 2. env names
  const names = (f: string) =>
    existsSync(f)
      ? new Set(
          [...readFileSync(f, "utf8").matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]),
        )
      : new Set<string>();
  const have = names(".env.local");
  const missing = [...names(".env.example")].filter((n) => !have.has(n));
  report(
    !missing.length,
    ".env.local covers .env.example",
    missing.length ? `missing: ${missing.join(", ")}` : "all names present",
  );

  // 3. code checks
  if (quick) console.log("SKIP  lint / typecheck / unit / check:imports / RLS (--quick)");
  else
    for (const [name, cmd] of <[string, string][]>[
      ["lint", "pnpm lint"],
      ["typecheck", "pnpm typecheck"],
      ["unit tests", "pnpm test"],
      ["privileged-import check", "pnpm check:imports"],
      ["no table without RLS (check:rls)", "pnpm check:rls"],
      ["RLS tests", "pnpm test:rls"],
    ]) {
      const r = run(cmd);
      report(r.ok, name, summary(r.out).slice(0, 160));
    }

  // 4. CI gating main's tip. CI runs on pull requests (not on pushes to main), so look at the
  // PR that was merged last (squash merges leave no run on the merge commit itself).
  const pr = gh("pr list --state merged --base main --limit 1 --json number,headRefOid,title");
  try {
    const [merged] = JSON.parse(pr.out);
    const runs = JSON.parse(gh(`run list --workflow ci.yml --commit ${merged.headRefOid} --limit 1 --json conclusion,status`).out);
    const tip = run("git rev-parse --short origin/main").out;
    const behind = run("git rev-list --count origin/main..origin/develop").out;
    report(runs[0]?.conclusion === "success", "latest CI run gating main", `PR #${merged.number} CI ${runs[0]?.conclusion ?? "none"}; main tip ${tip}; develop is ${behind} commit(s) ahead of main`);
  } catch {
    report(false, "latest CI run gating main", lastLine(pr.out) || "no merged PR into main");
  }

  // 5. branch protection
  const prot = gh(
    `api repos/{owner}/{repo}/branches/main/protection --jq "[.required_status_checks.contexts, .enforce_admins.enabled, .allow_force_pushes.enabled] | tostring"`,
  );
  report(
    prot.ok,
    "branch protection on main",
    prot.ok ? `checks/enforce_admins/force-push: ${prot.out}` : lastLine(prot.out),
  );

  // 6. GitHub secrets (names only)
  for (const env of ["staging", "production"]) {
    const r = gh(`secret list --env ${env} --json name --jq ".[].name"`);
    const got = r.ok ? r.out.split(/\r?\n/).filter(Boolean) : [];
    const miss = REQUIRED_SECRETS.filter((s) => !got.includes(s));
    report(
      r.ok && !miss.length,
      `GitHub secrets: ${env}`,
      r.ok ? (miss.length ? `missing: ${miss.join(", ")}` : got.join(", ")) : lastLine(r.out),
    );
  }

  // 7. staging health vs develop head (staging deploys from develop)
  run("git fetch origin develop --quiet");
  const head = run("git rev-parse origin/develop").out;
  try {
    const res = await fetch(`${STAGING_URL}/api/health`, { signal: AbortSignal.timeout(15_000) });
    const body = (await res.json()) as { commit?: string; database?: string; jobs?: string };
    const live = body.commit ?? "";
    const current = live.length >= 7 && head.startsWith(live.slice(0, 40));
    report(
      res.status === 200 && current,
      "staging /api/health",
      `HTTP ${res.status}, db=${body.database}, jobs=${body.jobs}, live=${live.slice(0, 7)}, origin/develop=${head.slice(0, 7)}`,
    );
  } catch (e) {
    report(false, "staging /api/health", String((e as Error).message));
  }

  // 8. Claude Code setup
  const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8"));
  const enabled = Object.keys(settings.enabledPlugins ?? {}).filter(
    (k) => settings.enabledPlugins[k],
  );
  const installedFile = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  const installed = existsSync(installedFile)
    ? Object.keys(JSON.parse(readFileSync(installedFile, "utf8")).plugins ?? {})
    : [];
  const notInstalled = enabled.filter((p) => !installed.includes(p));
  report(
    enabled.length >= 6 && !notInstalled.length,
    "Claude plugins installed",
    notInstalled.length
      ? `not installed: ${notInstalled.join(", ")}`
      : `${enabled.length} enabled and installed`,
  );
  const mcp = existsSync(".mcp.json")
    ? Object.keys(JSON.parse(readFileSync(".mcp.json", "utf8")).mcpServers ?? {})
    : [];
  report(mcp.length > 0, "MCP servers configured", mcp.join(", ") || "none");
  const hookEvents = Object.keys(settings.hooks ?? {});
  report(
    ["PreToolUse", "PostToolUse", "SessionStart"].every((h) => hookEvents.includes(h)),
    "hooks registered",
    hookEvents.join(", "),
  );
  const agents = existsSync(".claude/agents")
    ? readdirSync(".claude/agents").filter((f) => f.endsWith(".md"))
    : [];
  report(agents.length === 3, "subagents present", agents.join(", "));

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nPhase 0 verified: all checks passed");
  process.exitCode = failed ? 1 : 0;
}

main();
