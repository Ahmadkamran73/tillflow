import "server-only";
import nodemailer, { type Transporter } from "nodemailer";

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

export type MailResult = "sent" | "not_configured" | "failed";

/**
 * Sends one email over SMTP (nodemailer). Never throws and never logs the recipient or the SMTP
 * error (it can echo the address). Gmail rewrites From to the signed-in account, so `from`
 * should be that address until a tillflow.ie mailbox exists.
 */
export async function sendMail(m: {
  from: string | undefined;
  to: string | undefined;
  subject: string;
  text: string;
  html?: string;
}): Promise<MailResult> {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!m.to || !m.from || !host || !user || !pass) return "not_configured";
  try {
    await getTransport(host, user, pass).sendMail({
      from: m.from,
      to: m.to,
      subject: m.subject.slice(0, 200),
      text: m.text,
      html: m.html,
    });
    return "sent";
  } catch {
    return "failed";
  }
}
