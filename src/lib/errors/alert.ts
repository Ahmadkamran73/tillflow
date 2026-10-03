import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "@/lib/logger";

let transport: Transporter | undefined;

function getTransport(host: string, user: string, pass: string) {
  // Port 465 = implicit TLS (Gmail, Hostinger); 587 = STARTTLS, which nodemailer upgrades itself.
  const port = Number(process.env.SMTP_PORT) || 465;
  transport ??= nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return transport;
}

/**
 * Sends an alert email to ALERT_EMAIL over SMTP (nodemailer). Never throws.
 * Gmail rewrites From to the signed-in account, so ALERT_FROM should be that address until a
 * tillflow.ie mailbox exists. Callers pass already-scrubbed text only.
 */
export async function sendAlertEmail(subject: string, text: string): Promise<boolean> {
  const to = process.env.ALERT_EMAIL;
  const from = process.env.ALERT_FROM;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!to || !from || !host || !user || !pass) {
    logger.warn(
      { job: "alert" },
      "alert email skipped: ALERT_EMAIL, ALERT_FROM or SMTP_HOST/SMTP_USER/SMTP_PASS not set",
    );
    return false;
  }
  try {
    await getTransport(host, user, pass).sendMail({
      from,
      to,
      subject: subject.slice(0, 200),
      text,
    });
    return true;
  } catch {
    // Never log the error object: SMTP errors can echo the address or server response.
    logger.error({ job: "alert" }, "alert email failed");
    return false;
  }
}
