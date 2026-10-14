import type { Metadata } from "next";
import { AuthForm } from "@/app/(auth)/_components/auth-form";
import { requireRole } from "@/lib/auth";
import { reauthenticateAction } from "@/lib/auth/actions";
import { safeNext } from "@/lib/auth/redirect";
import { t } from "@/lib/i18n";

export const metadata: Metadata = {
  title: `${t("accountExport.confirm.title")} · ${t("app.name")}`,
};

/** Asks an owner to prove who they are again before the whole-account export (good for 10 minutes). */
export default async function ConfirmPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ next?: string }>;
}) {
  const { orgId } = await params;
  const { user } = await requireRole("owner", orgId);
  const next = safeNext((await searchParams).next, `/o/${orgId}/settings/export`);

  return (
    <section className="flex max-w-md flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">
        {t("accountExport.confirm.title")}
      </h1>
      <p className="text-muted-foreground text-sm">
        {user.hasVerifiedFactor
          ? t("accountExport.confirm.totp")
          : t("accountExport.confirm.password")}
      </p>
      <AuthForm
        action={reauthenticateAction}
        submitLabel={t("accountExport.confirm.submit")}
        hidden={{ next }}
        fields={
          user.hasVerifiedFactor
            ? [
                {
                  name: "code",
                  label: t("accountExport.confirm.codeLabel"),
                  autoComplete: "one-time-code",
                  inputMode: "numeric",
                  maxLength: 6,
                },
              ]
            : [
                {
                  name: "password",
                  label: t("accountExport.confirm.passwordLabel"),
                  type: "password",
                  autoComplete: "current-password",
                },
              ]
        }
      />
    </section>
  );
}
