import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { savePinAction } from "@/lib/device/admin-actions";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: `${t("pin.title")} · ${t("app.name")}` };

const messages: Record<string, { key: Parameters<typeof t>[0]; ok: boolean }> = {
  saved: { key: "pin.saved", ok: true },
  mismatch: { key: "pin.mismatch", ok: false },
  invalid: { key: "pin.error", ok: false },
  error: { key: "pin.error", ok: false },
};

export default async function MyPinPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  const { user } = await requireRole(["owner", "manager"], orgId);
  const { result } = await searchParams;

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("memberships")
    .select("display_name, pin_set_at")
    .eq("org_id", orgId)
    .eq("user_id", user.id)
    .maybeSingle();
  const message = result ? messages[result] : undefined;

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("pin.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("pin.body")}</p>
      <p className="text-sm font-medium">{data?.pin_set_at ? t("pin.hasPin") : t("pin.noPin")}</p>

      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          tabIndex={-1}
          autoFocus
          className={message.ok ? "rounded-lg border p-3 text-sm" : "text-destructive text-sm"}
        >
          {t(message.key)}
          {result === "invalid" ? ` ${t("pin.body")}` : ""}
        </p>
      )}

      <form action={savePinAction} className="flex flex-col gap-4">
        <input type="hidden" name="orgId" value={orgId} />
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("pin.name")}
          <Input
            name="name"
            required
            maxLength={40}
            autoComplete="off"
            defaultValue={data?.display_name ?? ""}
            className="h-12"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("pin.pin")}
          <Input
            name="pin"
            type="password"
            inputMode="numeric"
            required
            minLength={4}
            maxLength={6}
            pattern="[0-9]{4,6}"
            autoComplete="off"
            className="h-12"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("pin.confirm")}
          <Input
            name="confirm"
            type="password"
            inputMode="numeric"
            required
            minLength={4}
            maxLength={6}
            pattern="[0-9]{4,6}"
            autoComplete="off"
            className="h-12"
          />
        </label>
        <Button type="submit" className="h-12 self-start px-5">
          {t("pin.save")}
        </Button>
      </form>
    </section>
  );
}
