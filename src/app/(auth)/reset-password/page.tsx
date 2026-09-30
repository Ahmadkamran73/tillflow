import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { updatePasswordAction } from "@/lib/auth/actions";
import { AuthForm } from "../_components/auth-form";

export const metadata: Metadata = { title: "Choose a new password · Tillflow POS" };

export default async function ResetPasswordPage() {
  const user = await requireUser(); // the recovery link signs the user in; no session means an expired link
  // An emailed link alone must not bypass two-step verification (Supabase refuses the change too).
  if (user.hasVerifiedFactor && user.aal !== "aal2") redirect("/mfa?next=%2Freset-password");
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <AuthForm
        action={updatePasswordAction}
        submitLabel="Save new password"
        fields={[
          {
            name: "password",
            label: "New password",
            type: "password",
            autoComplete: "new-password",
            hint: "At least 10 characters with upper-case, lower-case and a number.",
          },
          {
            name: "confirmPassword",
            label: "Confirm new password",
            type: "password",
            autoComplete: "new-password",
          },
        ]}
      />
    </>
  );
}
