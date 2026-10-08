import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireRole } from "@/lib/auth";
import { setRefundLimitAction } from "@/lib/device/admin-actions";
import { t } from "@/lib/i18n";
import { centsToInput, formatCents } from "@/lib/money";
import { getOrganisation } from "@/lib/org";

export const metadata: Metadata = { title: `${t("refunds.limitTitle")} · ${t("app.name")}` };

const messages: Record<string, { key: Parameters<typeof t>[0]; ok: boolean }> = {
  saved: { key: "refunds.limitSaved", ok: true },
  invalid: { key: "refunds.limitInvalid", ok: false },
  error: { key: "refunds.limitError", ok: false },
};

export default async function RefundLimitPage({
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
      <h1 className="text-title font-semibold tracking-tight">{t("refunds.limitTitle")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("refunds.limitBody")}</p>
      <p className="text-sm font-medium">
        {t("refunds.limitCurrent", { amount: formatCents(org.refundOverrideCents) })}
      </p>

      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          id="refund-limit-result"
          className={message.ok ? "rounded-lg border p-3 text-sm" : "text-destructive text-sm"}
        >
          {t(message.key)}
        </p>
      )}

      <form action={setRefundLimitAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="orgId" value={orgId} />
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("refunds.limitLabel")}
          <span id="refund-limit-hint" className="text-muted-foreground text-xs font-normal">
            {t("refunds.limitHint")}
          </span>
          <Input
            name="euro"
            aria-describedby={
              result === "invalid" ? "refund-limit-hint refund-limit-result" : "refund-limit-hint"
            }
            aria-invalid={result === "invalid"}
            inputMode="decimal"
            required
            autoComplete="off"
            defaultValue={centsToInput(org.refundOverrideCents)}
            className="h-12 w-32"
          />
        </label>
        <Button type="submit" className="h-12 px-5">
          {t("refunds.limitSave")}
        </Button>
      </form>
    </section>
  );
}
