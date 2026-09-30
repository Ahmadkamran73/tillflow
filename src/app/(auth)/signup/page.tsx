import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { isGoogleAuthEnabled } from "@/lib/auth";
import { signInWithGoogleAction, signUpAction } from "@/lib/auth/actions";
import { AuthForm } from "../_components/auth-form";

export const metadata: Metadata = { title: "Create account · Tillflow POS" };

export default function SignUpPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Create your account</h1>
      <AuthForm
        action={signUpAction}
        submitLabel="Create account"
        fields={[
          { name: "businessName", label: "Business name", autoComplete: "organization" },
          { name: "email", label: "Email", type: "email", autoComplete: "email" },
          {
            name: "password",
            label: "Password",
            type: "password",
            autoComplete: "new-password",
            hint: "At least 10 characters with upper-case, lower-case and a number.",
          },
        ]}
      />

      {isGoogleAuthEnabled() ? (
        <form action={signInWithGoogleAction}>
          <Button type="submit" variant="outline" className="h-12 w-full">
            Continue with Google
          </Button>
        </form>
      ) : null}

      <p className="text-sm">
        Already have an account?{" "}
        <Link href="/login" className="underline underline-offset-4">
          Log in
        </Link>
      </p>
    </>
  );
}
