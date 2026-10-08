import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { t, type MessageKey } from "@/lib/i18n";
import {
  addTenderTypeAction,
  archiveTenderTypeAction,
  renameTenderTypeAction,
} from "@/lib/tender-admin-actions";

export const metadata: Metadata = { title: `${t("tenders.title")} · ${t("app.name")}` };

const messages: Record<string, { key: MessageKey; ok: boolean }> = {
  saved: { key: "tenders.saved", ok: true },
  invalid: { key: "tenders.invalid", ok: false },
  error: { key: "tenders.error", ok: false },
};

type Row = {
  id: string;
  method: "cash" | "card" | "voucher";
  label: string;
  archived_at: string | null;
};

export default async function TenderTypesPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const location = await getLocation(orgId);
  if (!location) notFound();
  const { result } = await searchParams;
  const message = result ? messages[result] : undefined;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("tender_types")
    .select("id, method, label, archived_at")
    .eq("org_id", orgId)
    .eq("location_id", location.id)
    .order("sort")
    .order("label");
  if (error) throw new Error("Could not load payment types");
  const rows = (data ?? []) as Row[];

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("tenders.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("tenders.body")}</p>

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

      <ul className="surface-panel divide-border divide-y" aria-label={t("tenders.list")}>
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-end gap-3 px-5 py-3">
            <div className="flex min-w-40 flex-1 flex-col">
              <span className="font-medium">{r.label}</span>
              <span className="text-muted-foreground text-sm">
                {t(`tenders.method.${r.method}` as MessageKey)}
                {r.archived_at ? ` · ${t("tenders.archived")}` : ""}
              </span>
            </div>
            {r.method === "cash" ? (
              <span className="text-muted-foreground text-sm">{t("tenders.cashNote")}</span>
            ) : (
              <>
                <form action={renameTenderTypeAction} className="flex items-end gap-2">
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="id" value={r.id} />
                  <Input
                    name="label"
                    required
                    maxLength={40}
                    autoComplete="off"
                    defaultValue={r.label}
                    aria-label={t("tenders.renameFor", { label: r.label })}
                    className="h-12 w-52"
                  />
                  <Button
                    type="submit"
                    variant="outline"
                    className="h-12 px-4"
                    aria-label={`${t("tenders.rename")} ${r.label}`}
                  >
                    {t("tenders.rename")}
                  </Button>
                </form>
                <form action={archiveTenderTypeAction}>
                  <input type="hidden" name="orgId" value={orgId} />
                  <input type="hidden" name="id" value={r.id} />
                  {r.archived_at && <input type="hidden" name="restore" value="1" />}
                  <Button
                    type="submit"
                    variant="outline"
                    className="h-12 px-4"
                    aria-label={`${r.archived_at ? t("tenders.restore") : t("tenders.archive")} ${r.label}`}
                  >
                    {r.archived_at ? t("tenders.restore") : t("tenders.archive")}
                  </Button>
                </form>
              </>
            )}
          </li>
        ))}
      </ul>

      <form
        action={addTenderTypeAction}
        className="surface-panel flex flex-wrap items-end gap-3 p-5"
      >
        <input type="hidden" name="orgId" value={orgId} />
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("tenders.method")}
          <select
            name="method"
            className="border-input bg-background h-12 rounded-md border px-3 text-base"
            defaultValue="card"
          >
            <option value="card">{t("tenders.method.card")}</option>
            <option value="voucher">{t("tenders.method.voucher")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("tenders.label")}
          <Input name="label" required maxLength={40} autoComplete="off" className="h-12 w-64" />
        </label>
        <Button type="submit" className="h-12 px-5">
          {t("tenders.add")}
        </Button>
      </form>
    </section>
  );
}
