import { z } from "zod";

export const roles = ["owner", "manager", "cashier"] as const;
export type Role = (typeof roles)[number];

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
// Supabase (bcrypt) ignores anything past 72 bytes; refuse it instead of silently truncating.
const password = z
  .string()
  .min(10, "Use at least 10 characters.")
  .max(72, "Use at most 72 characters.")
  .regex(/[a-z]/, "Include a lower-case letter.")
  .regex(/[A-Z]/, "Include an upper-case letter.")
  .regex(/[0-9]/, "Include a digit.");

export const businessName = z.string().trim().min(1, "Enter your business name.").max(120);

export const createOrganisationInput = z.object({ businessName });
export const signUpInput = z.object({ email, password, businessName });
export const signInInput = z.object({ email, password: z.string().min(1).max(72) });
export const emailOnlyInput = z.object({ email });
export const resetPasswordInput = z
  .object({ password, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "The passwords do not match.",
  });
export const totpCodeInput = z.object({
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code from your authenticator app."),
});
export const mfaEnrolVerifyInput = totpCodeInput.extend({ factorId: z.uuid() });

/** Auth callback query: either a PKCE `code` (OAuth) or an email `token_hash` + `type`. */
export const callbackTypes = ["email", "signup", "magiclink", "recovery"] as const;
export const callbackParams = z.object({
  code: z.string().min(1).max(512).optional(),
  token_hash: z.string().min(1).max(512).optional(),
  type: z.enum(callbackTypes).optional(),
});

/** What the UI shows after a server action. Never contains raw provider errors. */
export type FormState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Partial<Record<string, string[]>>;
};

export function fieldErrorsOf(error: z.ZodError): FormState["fieldErrors"] {
  return z.flattenError(error).fieldErrors as FormState["fieldErrors"];
}
