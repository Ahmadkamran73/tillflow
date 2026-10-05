import { expect, type Page } from "@playwright/test";
import { createHmac, randomUUID } from "node:crypto";

/** Local Supabase catches every auth email here (Mailpit). Tests never touch a real inbox. */
const MAIL_API = process.env.E2E_MAIL_API ?? "http://127.0.0.1:54324/api/v1";

export const PASSWORD = "Correct-horse-9";

export function uniqueEmail(label: string) {
  return `e2e-${label}-${randomUUID().slice(0, 8)}@example.test`;
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) so the test can act as the authenticator app. */
export function totp(base32Secret: string, now = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of base32Secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const code =
    (((hmac[offset]! & 0x7f) << 24) |
      (hmac[offset + 1]! << 16) |
      (hmac[offset + 2]! << 8) |
      hmac[offset + 3]!) %
    1_000_000;
  return code.toString().padStart(6, "0");
}

/** Waits for the newest email to `to` and returns the first link in it that points at the app. */
export async function emailedLink(
  to: string,
  subject = "Confirm your Tillflow account",
): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(
      async () => {
        const search = await fetch(
          `${MAIL_API}/search?query=${encodeURIComponent(`to:${to} subject:"${subject}"`)}`,
        );
        const { messages } = (await search.json()) as { messages?: { ID: string }[] };
        const id = messages?.[0]?.ID;
        if (!id) return false;
        const message = (await (await fetch(`${MAIL_API}/message/${id}`)).json()) as {
          HTML?: string;
          Text?: string;
        };
        const body = `${message.HTML ?? ""} ${message.Text ?? ""}`;
        link = body
          .match(/https?:\/\/[^\s"'<>]*\/auth\/callback\?[^\s"'<>]+/)?.[0]
          ?.replaceAll("&amp;", "&");
        return Boolean(link);
      },
      { message: `an email for ${to}`, timeout: 20_000 },
    )
    .toBe(true);
  // Emails carry the Supabase SITE_URL; open them on whichever port this run is serving.
  const target = new URL(link!);
  const base = new URL(process.env.E2E_BASE_URL ?? "http://localhost:3000");
  target.protocol = base.protocol;
  target.host = base.host;
  return target.toString();
}

/**
 * Full new-owner journey through the real UI: sign up, confirm by email, enrol an authenticator
 * app, land on the onboarding wizard. Returns the account's secret so a later test can log in.
 */
export async function signUpAndEnrol(page: Page, email: string, businessName: string) {
  await page.goto("/signup");
  await page.getByLabel("Business name").fill(businessName);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");

  await page.goto(await emailedLink(email));

  // A confirmed user with no business creates one explicitly (name pre-filled from sign-up).
  await expect(page).toHaveURL(/\/start$/);
  await expect(page.getByLabel("Business name")).toHaveValue(businessName);
  await page.getByRole("button", { name: "Create business" }).click();

  // New owner: sent to set up an authenticator app before seeing anything.
  await expect(page).toHaveURL(/\/mfa\?next=%2Fonboarding/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.getByTestId("mfa-secret").textContent())!.replace(/\s/g, "");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on two-step verification" }).click();

  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: /^Step 1 of 4\s*Your business$/ })).toBeVisible();
  return { secret };
}

/** Walks the onboarding wizard to the dashboard; returns the org id from the URL. */
export async function openDashboard(
  page: Page,
  { type = "General / convenience", vat = "", tills = "1" } = {},
) {
  if (vat) await page.getByLabel("VAT number (optional)").fill(vat);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByText(type, { exact: true }).click();
  await expect(page.getByRole("radio", { name: type })).toBeChecked();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByLabel("Number of tills").fill(tills);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/dashboard$/);
  return /\/o\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
}

/** Sign out from the user menu in the back-office top bar. */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
}

/**
 * Waits until React has hydrated the page's form. Typing into a controlled input before that is
 * lost when hydration resets it to its initial state (slow on a cold dev server).
 */
export async function hydrated(page: Page) {
  await page.waitForFunction(() => {
    const form = document.querySelector("main form, form");
    return !!form && Object.keys(form).some((k) => k.startsWith("__reactProps$"));
  });
}
