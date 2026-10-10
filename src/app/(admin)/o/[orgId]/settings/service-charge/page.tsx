import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { presets } from "@/config/business-type-presets";
import { requireRole } from "@/lib/auth";
import { discountLimitText } from "@/lib/device/discount-limit";
import { t, type MessageKey } from "@/lib/i18n";
import { getOrganisation } from "@/lib/org";
import { setServiceChargeAction } from "@/lib/restaurant/admin-actions";

export const metadata: Metadata = { title: `${t("service.title")} · ${t("app.name")}` };

const messages: Record<string, { key: MessageKey; ok: boolean }> = {
  saved: { key: "service.saved", ok: true },
  invalid: { key: "service.error", ok: false },
  error: { key: "service.failed", ok: false },
};

export default async function ServiceChargePage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  await requireRole("owner", orgId);
  const org = await getOrganisation(orgId);
  if (!org || !presets[org.businessType].register.serviceCharge) notFound();
  const { result } = await searchParams;
  const message = result ? messages[result] : undefined;

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("service.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("service.intro")}</p>

      {message && (
        <p
          role={message.ok ? "status" : "alert"}
          id="service-result"
          className={message.ok ? "rounded-lg border p-3 text-sm" : "text-destructive text-sm"}
        >
          {t(message.key)}
        </p>
      )}

      <form action={setServiceChargeAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="orgId" value={orgId} />
        <div className="flex flex-col gap-1 text-sm">
          <label htmlFor="service-percent" className="font-medium">
            {t("service.label")}
          </label>
          <span id="service-hint" className="text-muted-foreground text-xs">
            {t("service.hint")}
          </span>
          <Input
            id="service-percent"
            name="percent"
            aria-describedby={result === "invalid" ? "service-hint service-result" : "service-hint"}
            aria-invalid={result === "invalid"}
            inputMode="decimal"
            required
            autoComplete="off"
            defaultValue={discountLimitText(org.serviceChargeBp)}
            className="h-12 w-32"
          />
        </div>
        <Button type="submit" className="h-12 px-5">
          {t("service.save")}
        </Button>
      </form>
    </section>
  );
}
