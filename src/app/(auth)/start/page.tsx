import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createOrganisationAction } from "@/lib/auth/actions";
import { createSupabaseServerClient } from "@/lib/auth";
import { AuthForm } from "../_components/auth-form";

export const metadata: Metadata = { title: "Create your business · Tillflow POS" };

export default async function StartPage() {
  const user = await requireUser();

  // Already belongs to a business (e.g. opened this page by hand): nothing to create.
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from("memberships").select("id").eq("user_id", user.id).limit(1);
  if (data && data.length > 0) redirect("/o");

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Create your business</h1>
      <p className="text-sm">
        You are signed in, but not part of a business yet. Name yours to get started. You will
        become its owner.
      </p>
      <AuthForm
        action={createOrganisationAction}
        submitLabel="Create business"
        fields={[
          {
            name: "businessName",
            label: "Business name",
            autoComplete: "organization",
            defaultValue: user.signUpBusinessName,
          },
        ]}
      />
    </>
  );
}
