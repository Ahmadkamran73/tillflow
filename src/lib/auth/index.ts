// Server-side auth API for the rest of the app. Import from "@/lib/auth", never from a provider SDK.
// Server actions live in "@/lib/auth/actions"; pure helpers in "./schemas" and "./redirect".
export {
  getAuthUser,
  provisionOrganisation,
  requireBackOffice,
  requireRole,
  requireUser,
} from "./session";
export type { AuthUser, Membership } from "./session";
export { createSupabaseServerClient } from "./server";
export { isGoogleAuthEnabled } from "./config";
export { roles } from "./schemas";
export type { Role } from "./schemas";
