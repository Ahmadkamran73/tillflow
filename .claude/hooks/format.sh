#!/usr/bin/env bash
# PostToolUse hook (Edit|Write): format the changed file with Prettier. Never fails the tool call.

input=$(cat)

file=$(printf '%s' "$input" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    try { process.stdout.write((JSON.parse(s).tool_input || {}).file_path || ""); } catch (e) {}
  });
')

[ -z "$file" ] && exit 0
[ -f "$file" ] || exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
pnpm exec prettier --write --ignore-unknown "$file" >/dev/null 2>&1
exit 0
