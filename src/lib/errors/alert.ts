import "server-only";
import { sendMail } from "@/lib/email";
import { logger } from "@/lib/logger";

/**
 * Sends an alert email to ALERT_EMAIL over SMTP (nodemailer). Never throws.
 * Gmail rewrites From to the signed-in account, so ALERT_FROM should be that address until a
 * tillflow.ie mailbox exists. Callers pass already-scrubbed text only.
 */
export async function sendAlertEmail(subject: string, text: string): Promise<boolean> {
  const result = await sendMail({
    from: process.env.ALERT_FROM,
    to: process.env.ALERT_EMAIL,
    subject,
    text,
  });
  if (result === "not_configured")
    logger.warn(
      { job: "alert" },
      "alert email skipped: ALERT_EMAIL, ALERT_FROM or SMTP_HOST/SMTP_USER/SMTP_PASS not set",
    );
  else if (result === "failed") logger.error({ job: "alert" }, "alert email failed");
  return result === "sent";
}
