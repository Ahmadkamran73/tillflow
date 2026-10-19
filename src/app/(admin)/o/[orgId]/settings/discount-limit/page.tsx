import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireRole } from "@/lib/auth";
import { setDiscountLimitAction } from "@/lib/device/admin-actions";
import { discountLimitText } from "@/lib/device/discount-limit";
import { t } from "@/lib/i18n";
import { getOrganisation } from "@/lib/org";

export const metadata: Metadata = { title: `${t("discountLimit.title")} · ${t("app.name")}` };

const messages: Record<string, { key: Parameters<typeof t>[0]; ok: boolean }> = {
  saved: { key: "discountLimit.saved", ok: true },
  invalid: { key: "discountLimit.invalid", ok: false },
  error: { key: "discountLimit.error", ok: false },
};

export default async function DiscountLimitPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  await requireRole("owner", orgId);
  const org = await getOrganisation(orgId);
  if (!org) notFound();
  const { result } = await searchParams;
  const message = result ? messages[result] : undefined;

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("discountLimit.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("discountLimit.body")}</p>

      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          tabIndex={-1}
          autoFocus
          className={message.ok ? "rounded-lg border p-3 text-sm" : "text-destructive text-sm"}
        >
          {t(message.key)}
        </p>
      )}

      <form action={setDiscountLimitAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="orgId" value={orgId} />
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("discountLimit.percent")}
          <Input
            name="percent"
            inputMode="decimal"
            required
            autoComplete="off"
            defaultValue={discountLimitText(org.discountOverrideBp)}
            className="h-12 w-32"
          />
        </label>
        <Button type="submit" className="h-12 px-5">
          {t("discountLimit.save")}
        </Button>
      </form>
    </section>
  );
}
