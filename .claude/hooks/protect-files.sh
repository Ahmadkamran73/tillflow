#!/usr/bin/env bash
# PreToolUse hook (Edit|Write): block edits to .env* files and to migrations already on main.
# Exit 2 = block, with the message on stderr shown to Claude. No jq needed (uses node).

input=$(cat)

file=$(printf '%s' "$input" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    try { process.stdout.write((JSON.parse(s).tool_input || {}).file_path || ""); } catch (e) {}
  });
')

[ -z "$file" ] && exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
norm=$(printf '%s' "$file" | tr '\\' '/')
rootn=$(printf '%s' "$root" | tr '\\' '/')
rel="${norm#"$rootn"/}"
base="${rel##*/}"

# 1. Environment files (includes .env.example on purpose: change it by hand).
case "$base" in
  .env | .env.*)
    echo "BLOCKED: $rel is an environment file. Never edit .env* with Claude. Ask the user to make the change." >&2
    exit 2
    ;;
esac

# 2. Migrations that are already committed to main are immutable.
case "$rel" in
  supabase/migrations/*)
    for ref in main origin/main; do
      if git -C "$root" cat-file -e "$ref:$rel" 2>/dev/null; then
        echo "BLOCKED: $rel is already committed to $ref. Migrations are never edited after merge. Write a new migration instead." >&2
        exit 2
      fi
    done
    ;;
esac

exit 0
