import "server-only";
import { logger } from "@/lib/logger";

/**
 * Sends an alert email to ALERT_EMAIL through the Resend HTTP API. Never throws.
 * Staging sends from onboarding@resend.dev (only delivers to the Resend account's own email);
 * production uses a verified tillflow.ie address. Callers pass already-scrubbed text only.
 */
export async function sendAlertEmail(subject: string, text: string): Promise<boolean> {
  const to = process.env.ALERT_EMAIL;
  const from = process.env.ALERT_FROM;
  const apiKey = process.env.RESEND_API_KEY;
  if (!to || !from || !apiKey) {
    logger.warn(
      { job: "alert" },
      "alert email skipped: ALERT_EMAIL, ALERT_FROM or RESEND_API_KEY not set",
    );
    return false;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: subject.slice(0, 200), text }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) logger.error({ job: "alert", status: res.status }, "alert email rejected");
    return res.ok;
  } catch {
    logger.error({ job: "alert" }, "alert email failed");
    return false;
  }
}
