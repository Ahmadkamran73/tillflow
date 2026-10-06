import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import {
  TILL_NAME,
  TILL_PIN,
  hydrated,
  makePairingCode,
  openDashboard,
  openTill,
  pairWithCode,
  setMyPin,
  signUpAndEnrol,
  uniqueEmail,
  unlockTill,
} from "./helpers";

// Needs the local Supabase stack and its .env.local values (DIRECT_URL lets the test look at the
// server's tables as an administrator).

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 }, serviceWorkers: "block" });
test.setTimeout(180_000);

async function setup(page: Page, label: string) {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await signUpAndEnrol(page, uniqueEmail(label), `E2E pairing ${label}`);
  const orgId = await openDashboard(page);
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("10.00");
  await page.getByLabel("Barcode").fill("5012345678900");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
  return orgId;
}

const audit = async (orgId: string, action: string) =>
  (
    await sql`select count(*)::int as n from audit_log where org_id = ${orgId} and action = ${action}`
  )[0]!.n as number;

test("a pairing code works once; an expired or made-up code does not", async ({ page }) => {
  const orgId = await setup(page, "codes");
  await setMyPin(page, orgId);

  const code = await makePairingCode(page, orgId);
  await pairWithCode(page, code);
  await expect(page).toHaveURL(new RegExp(`/register/${orgId}$`));
  expect(await audit(orgId, "register.paired")).toBe(1);

  // The same code again (from a browser with no token): refused.
  const fresh = await page.context().browser()!.newContext();
  const other = await fresh.newPage();
  await pairWithCode(other, code);
  await expect(other.locator("#pair-error")).toContainText("not valid or has expired");
  await expect(other).toHaveURL(/\/register\/pair$/);

  // A code that has run out of its 10 minutes.
  const second = await makePairingCode(page, orgId);
  await sql`update register_pairing_codes set expires_at = now() - interval '1 second'
            where org_id = ${orgId} and used_at is null`;
  await pairWithCode(other, second);
  await expect(other.locator("#pair-error")).toContainText("not valid or has expired");

  // Something that is not a code at all never reaches the database.
  await other.getByLabel("Pairing code").fill("ABCDEFG0");
  await other.getByRole("button", { name: "Pair this till" }).click();
  await expect(other.locator("#pair-error")).toContainText("not valid or has expired");
  await fresh.close();
});

test("five wrong PINs lock that person; the right PIN is refused until a manager resets it", async ({
  page,
}) => {
  const orgId = await setup(page, "lockout");
  await openTill(page, orgId);
  await page.reload(); // locks the till again

  await page.getByRole("button", { name: new RegExp(`^${TILL_NAME}`) }).click();
  const pin = page.getByLabel(`PIN for ${TILL_NAME}`);
  for (let i = 1; i <= 4; i++) {
    await pin.fill("0369");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.locator("#pin-problem")).toContainText("That PIN is not right.");
  }
  await pin.fill("0369");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("#pin-problem")).toContainText("Locked until");

  // The right PIN no longer opens it, and the lock is in the database, not just on this screen.
  await pin.fill(TILL_PIN);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.locator("#pin-problem")).toContainText("Locked until");
  const [m] =
    await sql`select pin_locked_until from memberships where org_id = ${orgId} and role = 'owner'`;
  expect(new Date(m!.pin_locked_until).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
  expect(await audit(orgId, "staff.pin_locked")).toBe(1);
});

test("revoking a till stops it at once; its sales wait on the device", async ({ page }) => {
  const orgId = await setup(page, "revoke");
  await openTill(page, orgId);
  expect((await page.request.get(`/api/v1/catalog/${orgId}`)).status()).toBe(200);

  await page.goto(`/o/${orgId}/settings/tills`);
  await expect(page.getByText("Paired", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Revoke Till 1" }).click();
  await page.getByRole("button", { name: "Yes, revoke" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Till 1 was revoked." })).toBeVisible();
  expect(await audit(orgId, "register.revoked")).toBe(1);

  // The device token no longer opens anything.
  expect((await page.request.get(`/api/v1/catalog/${orgId}`)).status()).toBe(401);
  expect(
    (
      await page.request.post(`/api/v1/register/unlock`, {
        data: { userId: "00000000-0000-4000-8000-000000000001", pin: TILL_PIN, purpose: "unlock" },
      })
    ).status(),
  ).toBe(401);
  await page.goto(`/register/${orgId}`);
  await expect(page).toHaveURL(/\/register\/pair$/);
});

test("a discount above the limit needs a manager PIN and is audit-logged; so is a no-sale drawer open", async ({
  page,
}) => {
  const orgId = await setup(page, "override");
  await openTill(page, orgId);

  // 10% (the default limit) is fine without anyone's approval.
  await page.getByRole("button", { name: /^Tea bags/ }).click();
  await page.getByRole("button", { name: "Discount on Tea bags" }).click();
  await page.getByRole("textbox", { name: "Percent (%)" }).fill("10");
  await page.getByRole("button", { name: "Apply discount" }).click();
  await page.getByRole("button", { name: "Pay €9.00" }).click();
  await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();

  // 50% is not: Pay asks for a manager first. A wrong PIN does not approve it.
  await page.getByRole("button", { name: "Discount on Tea bags" }).click();
  await page.getByRole("textbox", { name: "Percent (%)" }).fill("50");
  await page.getByRole("button", { name: "Apply discount" }).click();
  await page.getByRole("button", { name: "Pay €5.00" }).click();
  await expect(page.getByRole("heading", { name: "Manager approval needed" })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${TILL_NAME}`) }).click();
  await page.getByLabel(`PIN for ${TILL_NAME}`).fill("0369");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator("#pin-problem")).toContainText("That PIN is not right.");
  await page.getByLabel(`PIN for ${TILL_NAME}`).fill(TILL_PIN);
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: /^Exact/ }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();

  // The sale reaches the server, with the cashier and the approver on the record.
  await expect
    .poll(async () => (await sql`select 1 from sales where org_id = ${orgId}`).length, {
      timeout: 60_000,
    })
    .toBe(1);
  const [owner] =
    await sql`select user_id from memberships where org_id = ${orgId} and role = 'owner'`;
  const [sale] =
    await sql`select cashier_user_id, amount_due_cents from sales where org_id = ${orgId}`;
  expect(sale).toMatchObject({ cashier_user_id: owner!.user_id, amount_due_cents: 500 });
  const [ov] = await sql`select actor_user_id, after from audit_log
    where org_id = ${orgId} and action = 'sale.discount_override'`;
  expect(ov!.actor_user_id).toBe(owner!.user_id);
  expect(ov!.after).toMatchObject({ approved_by: owner!.user_id, discount_cents: 500 });
  await page.getByRole("button", { name: "New sale" }).click();

  // No sale: opening the drawer needs a manager too, and is recorded.
  await page.getByRole("button", { name: "Open drawer" }).click();
  await expect(page.getByRole("heading", { name: "Manager approval needed" })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${TILL_NAME}`) }).click();
  await page.getByLabel(`PIN for ${TILL_NAME}`).fill(TILL_PIN);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => audit(orgId, "register.no_sale"), { timeout: 60_000 }).toBe(1);
  const [ns] = await sql`select actor_user_id, after from audit_log
    where org_id = ${orgId} and action = 'register.no_sale'`;
  expect(ns!.actor_user_id).toBe(owner!.user_id);
  expect(ns!.after).toMatchObject({ approved_by: owner!.user_id });
});

test("the till locks after the Lock button and needs the PIN again", async ({ page }) => {
  const orgId = await setup(page, "lockbutton");
  await openTill(page, orgId);
  await page.getByRole("button", { name: /^Lock till/ }).click();
  await expect(page.getByRole("heading", { name: "Who is using the till?" })).toBeVisible();
  await unlockTill(page);
});
