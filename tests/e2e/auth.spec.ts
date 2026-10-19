import { expect, test } from "@playwright/test";
import {
  emailedLink,
  signOut,
  openDashboard,
  PASSWORD,
  signUpAndEnrol,
  totp,
  uniqueEmail,
} from "./helpers";

// Needs the local Supabase stack (`supabase start`) and its .env.local values.

test("sign up, confirm email, enrol MFA, see the empty dashboard", async ({ page }) => {
  await signUpAndEnrol(page, uniqueEmail("owner"), "E2E Corner Shop");
  await openDashboard(page);

  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("No sales yet")).toBeVisible();
  await expect(page.getByText("E2E Corner Shop")).toBeVisible();
});

test("two-step verification can be skipped at sign-up, with a reminder until it is set up", async ({
  page,
}) => {
  const email = uniqueEmail("skipmfa");
  await page.goto("/signup");
  await page.getByLabel("Business name").fill("Skip MFA Shop");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page.goto(await emailedLink(email));
  await page.getByRole("button", { name: "Create business" }).click();

  await expect(page).toHaveURL(/\/mfa\?next=%2Fonboarding/);
  await page.getByRole("link", { name: "Skip for now" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await openDashboard(page);

  // The reminder shows on every back-office page until an authenticator is set up.
  await expect(page.getByText("Two-step verification is off")).toBeVisible();
  await page.getByRole("link", { name: "Set it up now" }).click();
  await expect(page).toHaveURL(/\/mfa\?next=/);
  await page.getByRole("button", { name: "Set up authenticator app" }).click();
  const secret = (await page.getByTestId("mfa-secret").textContent())!.replace(/\s/g, "");
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Turn on two-step verification" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByText("Two-step verification is off")).toHaveCount(0);
});

test("an owner who logs in again must pass the authenticator challenge", async ({ page }) => {
  const email = uniqueEmail("relogin");
  const { secret } = await signUpAndEnrol(page, email, "Relogin Cafe");
  await openDashboard(page);
  await signOut(page);
  await expect(page).toHaveURL(/\/login/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();

  // Password alone is not enough for an owner.
  await expect(page).toHaveURL(/\/mfa/);
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/dashboard$/);
});

test("password reset by email lets the owner log in with the new password", async ({ page }) => {
  const email = uniqueEmail("reset");
  const { secret } = await signUpAndEnrol(page, email, "Reset Books");
  await openDashboard(page);
  await signOut(page);

  await page.goto("/forgot-password");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status")).toContainText("reset link is on its way");

  // The emailed link alone is not enough for an owner: the authenticator challenge comes first.
  await page.goto(await emailedLink(email, "Reset your Tillflow password"));
  await expect(page).toHaveURL(/\/mfa\?next=%2Freset-password/);
  await page.getByLabel("6-digit code").fill(totp(secret));
  await page.getByRole("button", { name: "Verify" }).click();

  await expect(page).toHaveURL(/\/reset-password$/);
  const next = "Brand-new-pass-7";
  await page.getByLabel("New password", { exact: true }).fill(next);
  await page.getByLabel("Confirm new password").fill(next);
  await page.getByRole("button", { name: "Save new password" }).click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/dashboard$/);

  // The old password no longer works; the new one does (and still needs the authenticator code).
  await signOut(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert").first()).toHaveText("Incorrect email or password.");
  await page.getByLabel("Password").fill(next);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL(/\/mfa/);
});

test("a wrong password gets a generic error", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Email").fill(uniqueEmail("nobody"));
  await page.getByLabel("Password").fill("Wrong-password-1");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert").first()).toHaveText("Incorrect email or password.");
});

test("the sixth login attempt in a minute is refused, even with the right password", async ({
  page,
}) => {
  const email = uniqueEmail("limit");
  await page.goto("/login");
  for (let i = 0; i < 5; i++) {
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("Wrong-password-1");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("alert").first()).toHaveText("Incorrect email or password.");
    // React clears the password field once the action has finished; wait for that before refilling.
    await expect(page.getByLabel("Password")).toHaveValue("");
  }
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("Wrong-password-1");
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("alert").first()).toHaveText(/Too many attempts/);
});

test("logged-out visitors are sent to log in", async ({ page }) => {
  await page.goto("/o");
  await expect(page).toHaveURL(/\/login\?next=%2Fo/);
});

test("another shop's back office returns 404", async ({ browser }) => {
  const ownerA = await browser.newContext();
  const ownerB = await browser.newContext();
  const pageA = await ownerA.newPage();
  const pageB = await ownerB.newPage();

  await signUpAndEnrol(pageA, uniqueEmail("shop-a"), "Shop A");
  await signUpAndEnrol(pageB, uniqueEmail("shop-b"), "Shop B");
  const orgA = await openDashboard(pageA);
  const orgB = await openDashboard(pageB);
  expect(orgA).not.toBe(orgB);

  // A signed-in, MFA-verified owner of shop A asking for shop B's pages and for a made-up org.
  for (const path of [
    `/o/${orgB}/dashboard`,
    `/o/${orgB}`,
    `/o/${crypto.randomUUID()}/dashboard`,
    `/o/not-a-uuid/dashboard`,
  ]) {
    const response = await pageA.goto(path);
    expect(response?.status(), path).toBe(404);
    await expect(pageA.getByText("Shop B")).toHaveCount(0);
  }

  // Their own still works.
  const own = await pageA.goto(`/o/${orgA}/dashboard`);
  expect(own?.status()).toBe(200);

  await ownerA.close();
  await ownerB.close();
});
