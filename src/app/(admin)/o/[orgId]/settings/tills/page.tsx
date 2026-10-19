import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { requireRole, createSupabaseServerClient } from "@/lib/auth";
import { getLocation } from "@/lib/catalog";
import { addTillAction } from "@/lib/device/admin-actions";
import { t } from "@/lib/i18n";
import { TillsManager, type TillRow } from "./tills-manager";

export const metadata: Metadata = { title: `${t("tills.title")} · ${t("app.name")}` };

const messages: Record<string, { key: Parameters<typeof t>[0]; ok: boolean }> = {
  added: { key: "tills.added", ok: true },
  taken: { key: "tills.nameTaken", ok: false },
  error: { key: "tills.error", ok: false },
};

export default async function TillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  await requireRole(["owner", "manager"], orgId);
  const { result } = await searchParams;
  const location = await getLocation(orgId);

  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from("registers")
    .select("id, name, paired_at, last_seen_at")
    .eq("org_id", orgId)
    .order("name");
  const when = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: location?.timezone ?? "Europe/Dublin",
  });
  const tills: TillRow[] = (data ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    paired: r.paired_at !== null,
    lastSeen: r.last_seen_at ? when.format(new Date(r.last_seen_at)) : null,
  }));
  const message = result ? messages[result] : undefined;

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("tills.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("tills.body")}</p>

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

      <TillsManager orgId={orgId} tills={tills} />

      <form action={addTillAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="orgId" value={orgId} />
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("tills.addName")}
          <Input name="name" required maxLength={80} autoComplete="off" className="h-12 w-64" />
        </label>
        <Button type="submit" className="h-12 px-5">
          {t("tills.addSubmit")}
        </Button>
      </form>
    </section>
  );
}
