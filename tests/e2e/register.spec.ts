import { expect, test, type Page } from "@playwright/test";
import {
  hydrated,
  openDashboard,
  openTill,
  signUpAndEnrol,
  uniqueEmail,
  unlockTill,
} from "./helpers";

// Needs the local Supabase stack (`supabase start`) and its .env.local values.

test.use({ viewport: { width: 1024, height: 768 }, serviceWorkers: "block" });
// serviceWorkers: "block" so page.route() below sees the requests (with the service worker on,
// register-sync.spec.ts covers the real offline behaviour).
test.setTimeout(120_000); // signs up and creates products through the UI first

async function addProduct(
  page: Page,
  orgId: string,
  p: { name: string; price: string; barcode: string; age?: boolean },
) {
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill(p.name);
  await page.getByLabel("Price (including VAT)").fill(p.price);
  await page.getByLabel("Barcode").fill(p.barcode);
  if (p.age) await page.getByLabel("Age-restricted (ask for ID)").check();
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
}

test("general store: 3 items in 3 taps and cash tender; scan, discount, park and recall, age check, offline reload", async ({
  page,
}) => {
  await signUpAndEnrol(page, uniqueEmail("register"), "E2E register");
  const orgId = await openDashboard(page);
  await addProduct(page, orgId, { name: "Tea bags", price: "12.30", barcode: "5012345678900" });
  await addProduct(page, orgId, { name: "Milk", price: "1.50", barcode: "5012345678917" });
  await addProduct(page, orgId, { name: "Bread", price: "2.20", barcode: "5012345678924" });
  await addProduct(page, orgId, {
    name: "Whiskey",
    price: "30",
    barcode: "5012345678931",
    age: true,
  });

  await openTill(page, orgId);
  const tile = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) });
  await expect(tile("Tea bags")).toBeVisible();

  // The 3-tap sale.
  await tile("Tea bags").click();
  await tile("Milk").click();
  await tile("Bread").click();
  await expect(page.getByRole("button", { name: "Pay €16.00" })).toBeVisible();
  await expect(page.getByText("VAT included 23%")).toBeVisible();
  await page.getByRole("button", { name: "Pay €16.00" }).click();
  await page.getByRole("button", { name: /^Exact/ }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  await expect(page.getByText("Nothing in this sale yet")).toBeVisible();

  // A scan works wherever the focus is: the code arrives as fast keystrokes plus Enter.
  await page.keyboard.type("5012345678917");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Add one Milk" })).toBeVisible();
  await page.keyboard.type("0000000000");
  await page.keyboard.press("Enter");
  await expect(page.getByText("No product with barcode 0000000000.")).toBeAttached();

  // Line discount of 10% on €1.50 → €1.35.
  await page.getByRole("button", { name: "Discount on Milk" }).click();
  await page.getByRole("textbox", { name: "Percent (%)" }).fill("10");
  await page.getByRole("button", { name: "Apply discount" }).click();
  await expect(page.getByRole("button", { name: "Pay €1.35" })).toBeVisible();

  // Park, then the till is empty; recall brings it back.
  await page.getByRole("button", { name: "Park sale" }).click();
  await expect(page.getByText("Nothing in this sale yet")).toBeVisible();
  await page.getByRole("button", { name: "Recall (1)" }).click();
  await page.getByRole("button", { name: /1 items, parked/ }).click();
  await expect(page.getByRole("button", { name: "Pay €1.35" })).toBeVisible();

  // Age-restricted item asks once.
  await tile("Whiskey").click();
  await expect(page.getByRole("heading", { name: "Age check" })).toBeVisible();
  await page.getByRole("button", { name: "Customer is 18 or over" }).click();
  await expect(page.getByRole("button", { name: "Add one Whiskey" })).toBeVisible();

  // Offline: the catalogue endpoint is blocked, the till still loads its products from the device.
  await page.route("**/api/v1/catalog/**", (route) => route.abort());
  await page.reload();
  await unlockTill(page); // locks on reload; the PIN is checked against the hash saved on the till
  await expect(tile("Tea bags")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Offline" })).toBeVisible();
});

test("an unpaired browser is sent to the pairing page and cannot read any catalogue", async ({
  page,
}) => {
  await signUpAndEnrol(page, uniqueEmail("register-404"), "E2E register 404");
  const orgId = await openDashboard(page);
  const other = "00000000-0000-4000-8000-000000000000";
  // Being signed in to the back office is not enough: a till is a paired device.
  for (const org of [orgId, other]) {
    await page.goto(`/register/${org}`);
    await expect(page).toHaveURL(/\/register\/pair$/);
    expect((await page.request.get(`/api/v1/catalog/${org}`)).status()).toBe(401);
  }
});
