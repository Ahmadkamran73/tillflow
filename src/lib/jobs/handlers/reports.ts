import "server-only";
import { z } from "zod";
import { sendMail } from "@/lib/email";
import { buildAccountZip, ExportTooLarge } from "@/lib/export/account-zip";
import { logger } from "@/lib/logger";
import {
  accountExportBegin,
  accountExportFail,
  accountExportFinish,
  accountExportMailData,
  accountExportOwnerEmails,
  accountExportPurge,
  accountExportRows,
  rebuildDirtySummaries,
} from "@/lib/ops/db";
import type { JobHandler } from "../boss";

const noPayload = z.object({});
const BATCH = 300;
const NIGHTLY_MAX = 5000;

/** Rebuild every shop-local day that had a sale or refund land since the last run. */
export async function summaryJob(): Promise<void> {
  // One day per call, so each rebuild commits on its own and never holds a sale's row mark
  // for the length of a batch. A busy catch-up drains up to BATCH days per run.
  let days = 0;
  while (days < BATCH && (await rebuildDirtySummaries(1, 0)) > 0) days++;
  if (days > 0) logger.info({ job: "report-summary", days }, "report days rebuilt");
}

/** Nightly: mark and rebuild the last 3 days of every shop (renamed products, missed marks). */
export async function summaryNightlyJob(): Promise<void> {
  let days = await rebuildDirtySummaries(1, 3); // marks the last 3 days of every shop, then rebuilds one
  while (days > 0 && days < NIGHTLY_MAX && (await rebuildDirtySummaries(1, 0)) > 0) days++;
  logger.info({ job: "report-summary-nightly", days }, "report days rebuilt");
}

const appUrl = () =>
  (process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "");

/**
 * Tells every owner that an export was requested, so a stolen login cannot do it quietly. Says
 * nothing about who asked and never carries data or a link to the file. A failed email does not
 * stop the export; the audit log has the request either way.
 */
async function tellOwners(id: string): Promise<void> {
  const info = await accountExportOwnerEmails(id);
  if (!info) return;
  const when = new Date(info.requested_at).toISOString().replace("T", " ").slice(0, 16);
  for (const to of info.emails) {
    const r = await sendMail({
      from: process.env.ALERT_FROM,
      to,
      subject: `[Tillflow] A full data export was requested for ${info.org_name}`,
      text: [
        `An owner asked to download all the data held for ${info.org_name} (requested ${when} UTC).`,
        "",
        "The person who asked gets an email when it is ready. The file is never sent by email.",
        `If this was not you or another owner, change your password now and contact support: ${appUrl()}/o/${info.org_id}/settings`,
      ].join("\n"),
    });
    if (r === "failed") logger.warn({ job: "account-export" }, "owner notice email failed");
  }
}

/**
 * Builds the whole-account ZIP for one request and emails the owner a link to the settings page
 * (the download itself needs a signed-in owner). A too-large account fails with a code the owner
 * sees; any other error marks it failed and is rethrown to be logged.
 */
export async function accountExportJob(id: string): Promise<void> {
  const start = await accountExportBegin(id);
  if (!start) return;
  await tellOwners(id);
  try {
    const madeAt = new Date().toISOString();
    const zip = await buildAccountZip(
      (table, offset, limit) => accountExportRows(id, table, offset, limit),
      {
        shop: start.org_name,
        madeAt,
      },
    );
    await accountExportFinish(id, `tillflow-data-${madeAt.slice(0, 10)}.zip`, zip);
  } catch (error) {
    if (error instanceof ExportTooLarge) {
      await accountExportFail(id, "too_large");
      return;
    }
    // Marked failed at once (a retry would find it finished and do nothing), so the owner can ask
    // again straight away; the error still goes to our own error log.
    await accountExportFail(id, "failed");
    throw error;
  }
  const mail = await accountExportMailData(id);
  if (!mail?.email) return;
  const mb = (mail.size_bytes / 1_048_576).toFixed(1);
  const r = await sendMail({
    from: process.env.ALERT_FROM,
    to: mail.email,
    subject: `[Tillflow] Your data export for ${mail.org_name} is ready`,
    text: [
      `The export of all the data held for ${mail.org_name} is ready (${mb} MB).`,
      "",
      `Sign in as an owner and download it here: ${appUrl()}/o/${mail.org_id}/settings/export`,
      "",
      `The file is kept for 7 days. It holds your customers' details: keep it safe.`,
    ].join("\n"),
  });
  // The file is ready either way; the owner can find it in Settings if the email fails.
  if (r === "failed") logger.warn({ job: "account-export" }, "export email failed");
}

export const REPORT_HANDLERS: JobHandler[] = [
  { name: "report-summary", schema: noPayload, cron: "*/5 * * * *", handle: () => summaryJob() },
  {
    name: "report-summary-nightly",
    schema: noPayload,
    cron: "37 3 * * *",
    handle: () => summaryNightlyJob(),
  },
  {
    name: "account-export",
    schema: z.object({ export_id: z.uuid() }),
    handle: (data) => accountExportJob((data as { export_id: string }).export_id),
  },
  {
    name: "account-export-purge",
    schema: noPayload,
    cron: "47 * * * *",
    handle: async () => {
      const n = await accountExportPurge();
      if (n > 0) logger.info({ job: "account-export-purge", removed: n }, "export files removed");
    },
  },
];
