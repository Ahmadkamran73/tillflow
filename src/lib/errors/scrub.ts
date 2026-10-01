import { createHash } from "node:crypto";

/**
 * PII scrubbing for error logs (CLAUDE.md: never log personal data).
 * Allow-list: only the context keys below survive, and free text (messages, stacks) is masked.
 */

const ALLOWED_CONTEXT_KEYS = new Set([
  "source",
  "route",
  "method",
  "routeType",
  "digest",
  "code",
  "status",
  "bucket",
  "job",
  "environment",
  "commit",
]);

/** Ids are kept only when they really are UUIDs (never an email or name passed by mistake). */
const UUID_CONTEXT_KEYS = new Set(["org_id", "user_id"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Order matters: the most specific patterns run first, so a later, looser one (numbers, emails)
// cannot split a secret or a credential URL and leave part of it behind.
const MASKS: [RegExp, string][] = [
  [/\b(postgres(ql)?|https?):\/\/[^\s'"]*@[^\s'"]+/gi, "[url-with-credentials]"],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]"],
  [/\b(bearer|basic)\s+[\w.~+/=-]+/gi, "$1 [token]"],
  [/\b[A-Za-z0-9_-]{32,}\b/g, "[secret]"],
  [/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/\bIE\d{2}[A-Z]{4}\d{14}\b/gi, "[iban]"],
  [/\b(?:[A-Z]\d{2}|D6W)\s?[A-Z0-9]{4}\b/gi, "[eircode]"],
  [/\+?\d[\d\s-]{7,}\d/g, "[number]"],
];

export function scrubText(text: string, maxLength = 1000): string {
  let out = text.slice(0, maxLength * 2);
  for (const [pattern, replacement] of MASKS) out = out.replace(pattern, replacement);
  return out.slice(0, maxLength);
}

/** Keeps only allow-listed keys with short primitive values. */
export function scrubContext(ctx: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(ctx ?? {})) {
    if (UUID_CONTEXT_KEYS.has(key)) {
      if (typeof value === "string" && UUID.test(value)) out[key] = value.toLowerCase();
      continue;
    }
    if (!ALLOWED_CONTEXT_KEYS.has(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
      continue;
    out[key] = scrubText(String(value), 200);
  }
  return out;
}

/** Path only: query strings and fragments can carry emails and tokens. Ids become ":id". */
export function scrubRoute(route: string | undefined | null): string | null {
  if (!route) return null;
  const path = route.split(/[?#]/)[0] ?? "";
  return scrubText(
    path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id"),
    300,
  );
}

/** Same error, same fingerprint: ids, numbers and line/column positions are ignored. */
export function fingerprint(source: string, name: string, message: string, stack?: string | null) {
  const normalise = (s: string) =>
    s
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
      .replace(/:\d+:\d+/g, "")
      .replace(/\d+/g, "<n>")
      .replace(/\?[^\s)]*/g, "");
  const frames = (stack ?? "")
    .split("\n")
    .filter((line) => /^\s*at\s|@/.test(line))
    .slice(0, 3)
    .map((line) => normalise(line.trim()));
  return createHash("sha256")
    .update([source, name, normalise(message), ...frames].join("\n"))
    .digest("hex");
}
