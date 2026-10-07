import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { removeTillStaffAction, setMemberPinAction } from "@/lib/device/admin-actions";
import { t, type MessageKey } from "@/lib/i18n";
import { PinFields } from "../pin-fields";

// No name in the title: it would end up in the browser history.
export const metadata: Metadata = {
  title: `${t("staff.manageTitle")} · ${t("staff.title")} · ${t("app.name")}`,
};

const errors: Record<string, MessageKey> = {
  invalid: "staff.invalid",
  mismatch: "staff.mismatch",
  error: "staff.error",
};

export default async function ManageStaffPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string; membershipId: string }>;
  searchParams: Promise<{ result?: string; confirm?: string; n?: string }>;
}) {
  const { orgId, membershipId } = await params;
  await requireRole(["owner", "manager"], orgId);
  if (!z.uuid().safeParse(membershipId).success) notFound();
  const { result, confirm, n } = await searchParams;
  const error = result ? errors[result] : undefined;
  const confirming = confirm === "remove";

  const supabase = await createSupabaseServerClient();
  const { data: m } = await supabase
    .from("memberships")
    .select("id, display_name, till_only")
    .eq("org_id", orgId)
    .eq("id", membershipId)
    .maybeSingle();
  // Only till-only cashiers are managed here; people with a login set their own PIN.
  if (!m || !m.till_only) notFound();
  const name = m.display_name ?? t("staff.noName");
  const here = `/o/${orgId}/staff/${m.id}`;

  return (
    <section className="flex max-w-xl flex-col gap-6">
      <h1 className="text-title font-semibold tracking-tight">
        {t("staff.setPinTitle", { name })}
      </h1>
      <p className="max-w-prose text-sm">{t("staff.setPinBody", { name })}</p>

      {error && !confirming && (
        <p
          key={n}
          id="staff-error"
          role="alert"
          tabIndex={-1}
          autoFocus
          className="text-destructive text-sm"
        >
          {t(error)}
        </p>
      )}

      <form action={setMemberPinAction} className="flex flex-col gap-4">
        <input type="hidden" name="orgId" value={orgId} />
        <input type="hidden" name="membershipId" value={m.id} />
        <PinFields
          invalid={result === "mismatch" ? "confirm" : result === "invalid" ? "pin" : undefined}
          errorId="staff-error"
        />
        <Button type="submit" className="h-12 self-start px-5">
          {t("staff.setPin")}
        </Button>
      </form>

      <section aria-labelledby="remove-heading" className="surface-panel flex flex-col gap-3 p-5">
        <h2
          id="remove-heading"
          tabIndex={-1}
          autoFocus={confirming}
          className="text-heading font-semibold outline-none"
        >
          {t("staff.removeTitle")}
        </h2>
        {confirming ? (
          <>
            {error && (
              <p key={n} role="alert" className="text-destructive text-sm">
                {t(error)}
              </p>
            )}
            <p className="text-sm">{t("staff.removeConfirm", { name })}</p>
            <div className="flex flex-wrap gap-3">
              <form action={removeTillStaffAction}>
                <input type="hidden" name="orgId" value={orgId} />
                <input type="hidden" name="membershipId" value={m.id} />
                <Button type="submit" variant="destructive" className="h-12 px-5">
                  {t("staff.removeYes", { name })}
                </Button>
              </form>
              <Link
                href={here}
                className="inline-flex min-h-12 items-center px-2 text-sm underline underline-offset-4"
              >
                {t("staff.cancel")}
              </Link>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm">{t("staff.removeBody", { name })}</p>
            <Link
              href={`${here}?confirm=remove`}
              className="inline-flex min-h-12 items-center self-start text-sm font-medium underline underline-offset-4"
            >
              {t("staff.remove", { name })}
            </Link>
          </>
        )}
      </section>

      <Link
        href={`/o/${orgId}/staff`}
        className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
      >
        {t("staff.back")}
      </Link>
    </section>
  );
}
