import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { createSupabaseServerClient, requireRole } from "@/lib/auth";
import { requestAccountExportAction } from "@/lib/account-export/actions";
import { getLocation } from "@/lib/catalog";
import { t, type MessageKey } from "@/lib/i18n";

export const metadata: Metadata = { title: `${t("accountExport.title")} · ${t("app.name")}` };

const messages: Record<string, { key: MessageKey; ok: boolean }> = {
  requested: { key: "accountExport.requested", ok: true },
  limit: { key: "accountExport.limit", ok: false },
  error: { key: "accountExport.failed", ok: false },
  gone: { key: "accountExport.downloadFailed", ok: false },
};

/** Owners ask for the whole-account ZIP and download it here. */
export default async function AccountExportPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams: Promise<{ result?: string }>;
}) {
  const { orgId } = await params;
  await requireRole("owner", orgId);
  const { result } = await searchParams;
  const message = result ? messages[result] : undefined;
  const location = await getLocation(orgId);

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("account_exports")
    .select("id, status, size_bytes, error_code, requested_at, expires_at")
    .eq("org_id", orgId)
    .order("requested_at", { ascending: false })
    .limit(10);
  if (error) throw new Error("Could not load exports");
  const when = new Intl.DateTimeFormat("en-IE", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: location?.timezone ?? "Europe/Dublin",
  });

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-title font-semibold tracking-tight">{t("accountExport.title")}</h1>
      <p className="text-muted-foreground max-w-prose text-sm">{t("accountExport.intro")}</p>
      <p className="max-w-prose text-sm">{t("accountExport.warning")}</p>
      <p className="text-muted-foreground max-w-prose text-sm">{t("accountExport.emailNote")}</p>

      {message ? (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? "rounded-lg border p-3 text-sm" : "text-destructive text-sm"}
        >
          {t(message.key)}
        </p>
      ) : null}

      <form action={requestAccountExportAction}>
        <input type="hidden" name="orgId" value={orgId} />
        <Button type="submit" className="h-12 px-5">
          {t("accountExport.request")}
        </Button>
      </form>

      <h2 className="text-heading font-semibold">{t("accountExport.history")}</h2>
      {(data ?? []).length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("accountExport.none")}</p>
      ) : (
        <div
          className="surface-panel overflow-x-auto"
          role="region"
          tabIndex={0}
          aria-label={t("accountExport.history")}
        >
          <Table>
            <caption className="sr-only">{t("accountExport.history")}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("accountExport.col.asked")}</TableHead>
                <TableHead scope="col">{t("accountExport.col.status")}</TableHead>
                <TableHead scope="col" className="text-right">
                  {t("accountExport.col.size")}
                </TableHead>
                <TableHead scope="col">{t("accountExport.col.expires")}</TableHead>
                <TableHead scope="col">{t("accountExport.col.download")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data ?? []).map((e) => {
                // Expired files are switched off by the hourly purge; the download route checks too.
                const ready = e.status === "ready";
                const status = e.status as "queued" | "running" | "ready" | "failed";
                return (
                  <TableRow key={e.id as string}>
                    <TableHead scope="row" className="font-normal">
                      {when.format(new Date(e.requested_at as string))}
                    </TableHead>
                    <TableCell>
                      {t(`accountExport.status.${status}`)}
                      {status === "failed" && e.error_code ? (
                        <span className="text-muted-foreground block text-sm">
                          {t(
                            `accountExport.error.${
                              ["too_large", "expired", "stuck"].includes(e.error_code as string)
                                ? (e.error_code as "too_large" | "expired" | "stuck")
                                : "failed"
                            }`,
                          )}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right font-mono tabular-nums">
                      {e.size_bytes
                        ? `${((e.size_bytes as number) / 1_048_576).toFixed(1)} MB`
                        : ""}
                    </TableCell>
                    <TableCell>
                      {e.expires_at ? when.format(new Date(e.expires_at as string)) : ""}
                    </TableCell>
                    <TableCell>
                      {ready ? (
                        <a
                          href={`/o/${orgId}/settings/export/${e.id}/download`}
                          download
                          className="inline-flex min-h-12 items-center font-medium underline"
                        >
                          {t("accountExport.download")}
                        </a>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
