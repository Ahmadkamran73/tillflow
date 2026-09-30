/**
 * Only same-site relative paths may be used as a post-login destination, so `?next=` can never
 * bounce a user to another site. Rejects `//host`, `/\host`, absolute URLs, backslashes and
 * control characters.
 */
const UNSAFE_CHARS = new RegExp("[\\u0000-\\u001f\\u007f\\\\]");

export function safeNext(value: unknown, fallback = "/o"): string {
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (UNSAFE_CHARS.test(value)) return fallback;
  return value;
}
