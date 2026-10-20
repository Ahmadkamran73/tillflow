import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { FocusMessage } from "@/components/back-office/focus-message";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { requireSuperadmin } from "@/lib/auth";
import { loadBillingConfig } from "@/lib/billing/config";
import { t, type MessageKey } from "@/lib/i18n";
import {
  extendTrialAction,
  pauseOrganisationAction,
  unpauseFromOrgAction,
} from "@/lib/superadmin/actions";
import { orgUsage } from "@/lib/superadmin/data";
import { irishDateTime, irishDay } from "@/lib/superadmin/format";

export const dynamic = "force-dynamic";

const RESULTS: Record<string, { key: MessageKey; ok: boolean }> = {
  extended: { key: "superadmin.org.done.extended", ok: true },
  paused: { key: "superadmin.org.done.paused", ok: true },
  unpaused: { key: "superadmin.org.done.unpaused", ok: true },
  error: { key: "superadmin.org.error", ok: false },
};

export default async function SuperadminOrgPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const id = z.uuid().safeParse((await params).orgId);
  if (!id.success) notFound();
  const { user } = await requireSuperadmin(`/superadmin/orgs/${id.data}`);
  const u = await orgUsage(user.id, id.data).catch(() => null);
  if (!u) notFound();
  const sp = await searchParams;
  const result = sp.result && Object.hasOwn(RESULTS, sp.result) ? RESULTS[sp.result] : undefined;
  const config = loadBillingConfig();
  const holdDefault = config.ok ? config.config.graceDays : 7;
  const never = t("superadmin.orgs.never");
  const none = t("superadmin.orgs.none");

  const facts: [MessageKey, string][] = [
    ["superadmin.org.usage.type", u.business_type ?? none],
    ["superadmin.org.usage.sales7", String(u.sales_7d)],
    ["superadmin.org.usage.sales30", String(u.sales_30d)],
    ["superadmin.org.usage.products", String(u.products)],
    ["superadmin.org.usage.staff", String(u.staff)],
    ["superadmin.org.usage.tills", String(u.tills)],
    ["superadmin.org.usage.tillSeen", irishDateTime(u.tills_last_seen, never)],
    ["superadmin.org.usage.lastSale", irishDateTime(u.last_sale_at, never)],
    ["superadmin.org.usage.attention", String(u.open_attention)],
    ["superadmin.org.usage.openInvoices", String(u.open_invoices)],
    ["superadmin.orgs.col.lastPayment", irishDay(u.last_payment_at, none)],
    ["superadmin.orgs.col.trialEnd", irishDay(u.trial_ends_at, none)],
  ];

  const canExtend = u.org_status === "trial";
  const canPause = u.org_status === "trial" || u.org_status === "active";
  const paused = u.org_status === "read_only";
  const base = `/superadmin/orgs/${u.org_id}`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link href="/superadmin" className="inline-flex min-h-12 items-center text-sm underline">
          {t("superadmin.org.back")}
        </Link>
        <h1 className="text-title font-semibold tracking-tight">{u.name}</h1>
      </div>

      <FocusMessage message={result ? t(result.key) : ""} urgent={!!result && !result.ok} />

      <section aria-labelledby="usage" className="flex flex-col gap-3">
        <h2 id="usage" className="text-heading font-semibold">
          {t("superadmin.org.usage")}
        </h2>
        <dl className="surface-panel grid gap-x-8 gap-y-3 p-4 sm:grid-cols-2">
          {facts.map(([k, v]) => (
            <div key={k} className="flex flex-wrap justify-between gap-x-4">
              <dt className="text-muted-foreground text-sm">{t(k)}</dt>
              <dd className="font-mono text-sm tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="view" className="flex flex-col gap-2">
        <h2 id="view" className="text-heading font-semibold">
          {t("superadmin.org.viewAs")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("superadmin.org.viewAsHint")}</p>
        <Link
          href={`${base}/view/dashboard`}
          className="border-border inline-flex min-h-12 w-fit items-center rounded-full border-2 px-5 text-sm font-medium"
        >
          {t("superadmin.org.viewAs")}
        </Link>
      </section>

      <section aria-labelledby="actions" className="flex flex-col gap-4">
        <h2 id="actions" className="text-heading font-semibold">
          {t("superadmin.org.actions")}
        </h2>

        {canExtend ? (
          <details>
            <summary className="inline-flex min-h-12 cursor-pointer items-center font-medium underline">
              {t("superadmin.org.extend")}
            </summary>
            <form action={extendTrialAction} className="mt-2 flex max-w-xs flex-col gap-2">
              <input type="hidden" name="orgId" value={u.org_id} />
              <Label htmlFor="extend-days">{t("superadmin.org.extendDays")}</Label>
              <Input
                id="extend-days"
                name="days"
                type="number"
                min={1}
                max={90}
                defaultValue={14}
                required
                className="h-12"
              />
              <p id="extend-days-hint" className="text-muted-foreground text-xs">
                {t("superadmin.org.extendDaysHint")}
              </p>
              <Label htmlFor="extend-note">{t("superadmin.org.note")}</Label>
              <Input
                id="extend-note"
                name="note"
                required
                minLength={5}
                maxLength={300}
                aria-describedby="extend-note-hint"
                className="h-12"
              />
              <p id="extend-note-hint" className="text-muted-foreground text-xs">
                {t("superadmin.org.noteHint")}
              </p>
              <Button type="submit" className="h-12 px-5">
                {t("superadmin.org.extendConfirm")}
              </Button>
            </form>
          </details>
        ) : null}

        {canPause ? (
          <details>
            <summary className="inline-flex min-h-12 cursor-pointer items-center font-medium underline">
              {t("superadmin.org.pause")}
            </summary>
            <form action={pauseOrganisationAction} className="mt-2 flex max-w-xs flex-col gap-2">
              <input type="hidden" name="orgId" value={u.org_id} />
              <p className="text-sm">{t("superadmin.org.pauseWarn")}</p>
              <Label htmlFor="pause-note">{t("superadmin.org.note")}</Label>
              <Input
                id="pause-note"
                name="note"
                required
                minLength={5}
                maxLength={300}
                aria-describedby="pause-note-hint"
                className="h-12"
              />
              <p id="pause-note-hint" className="text-muted-foreground text-xs">
                {t("superadmin.org.noteHint")}
              </p>
              <Button type="submit" variant="outline" className="h-12 px-5">
                {t("superadmin.org.pauseConfirm")}
              </Button>
            </form>
          </details>
        ) : null}

        {paused ? (
          <details>
            <summary className="inline-flex min-h-12 cursor-pointer items-center font-medium underline">
              {t("superadmin.org.unpause")}
            </summary>
            <form action={unpauseFromOrgAction} className="mt-2 flex max-w-xs flex-col gap-2">
              <input type="hidden" name="orgId" value={u.org_id} />
              <Label htmlFor="unpause-note">{t("superadmin.org.note")}</Label>
              <Input
                id="unpause-note"
                name="note"
                required
                minLength={5}
                maxLength={300}
                aria-describedby="unpause-note-hint"
                className="h-12"
              />
              <p id="unpause-note-hint" className="text-muted-foreground text-xs">
                {t("superadmin.org.noteHint")}
              </p>
              <Label htmlFor="unpause-hold">{t("superadmin.org.holdDays")}</Label>
              <Input
                id="unpause-hold"
                name="holdDays"
                type="number"
                min={0}
                max={365}
                defaultValue={holdDefault}
                required
                className="h-12"
              />
              <Button type="submit" variant="outline" className="h-12 px-5">
                {t("superadmin.org.unpauseConfirm")}
              </Button>
            </form>
          </details>
        ) : null}
      </section>
    </div>
  );
}
