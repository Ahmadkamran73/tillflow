import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabaseEnv } from "./config";

/**
 * Supabase client bound to the signed-in user's cookies. It uses the anon key plus the user's JWT,
 * so Postgres RLS applies to everything it does. The service-role key is never used here.
 */
export async function createSupabaseServerClient() {
  const { url, anonKey } = supabaseEnv();
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Called from a Server Component, which cannot set cookies. proxy.ts refreshes the session.
        }
      },
    },
  });
}
