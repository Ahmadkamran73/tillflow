import "server-only";

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set");
  }
  return { url, anonKey };
}

export function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");
}

/**
 * A 303 to a path on this app, built from NEXT_PUBLIC_APP_URL and never from the request: behind
 * Hostinger's proxy the request's own host is the internal one (the same rule as the auth callback).
 * `path` must be a fixed in-app path; the origin cannot be changed by the caller.
 */
export function appRedirect(path: string): Response {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("appRedirect needs an in-app path");
  return Response.redirect(new URL(path, appUrl()), 303);
}

/** "Continue with Google" stays hidden and refused until this is exactly "true". */
export function isGoogleAuthEnabled(): boolean {
  return process.env.AUTH_GOOGLE_ENABLED === "true";
}
