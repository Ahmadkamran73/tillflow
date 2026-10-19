import { expect, test } from "@playwright/test";
import {
  hydrated,
  makePairingCode,
  openDashboard,
  openShiftIfAsked,
  pairWithCode,
  setMyPin,
  signUpAndEnrol,
  TILL_NAME,
  TILL_PIN,
  uniqueEmail,
} from "./helpers";

// One simulated account: add a customer at the till, sell to them, then run the back-office
// pages, the data export and the erasure. Roles and cross-shop access: tests/rls/customers.test.ts.

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(180_000);

test("customers: add at the till, sell, history, consent, export, delete personal data", async ({
  page,
}) => {
  await signUpAndEnrol(page, uniqueEmail("customers"), "E2E customers");
  const orgId = await openDashboard(page);
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("10.00");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);

  // A customer added in the back office.
  await page.goto(`/o/${orgId}/customers/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Pat Murphy");
  await page.getByLabel("Email").fill("pat@example.com");
  await page.getByLabel(/^VAT number/).fill("IE1234567X");
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page.getByText("Enter a valid VAT number, for example IE6388047V.")).toBeVisible();
  await page.getByLabel(/^VAT number/).fill("IE6388047V");
  await page.getByRole("button", { name: "Save customer" }).click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}\?saved=1$/);
  await expect(page.getByText("No consent")).toBeVisible();

  // The till: find that customer, add another, sell to the first.
  await setMyPin(page, orgId);
  await pairWithCode(page, await makePairingCode(page, orgId));
  await expect(page).toHaveURL(new RegExp(`/register/${orgId}$`));
  await page.getByRole("button", { name: new RegExp(`^${TILL_NAME}`) }).click();
  await page.getByLabel(`PIN for ${TILL_NAME}`).fill(TILL_PIN);
  await page.getByRole("button", { name: "Unlock" }).click();
  await openShiftIfAsked(page);

  await page.getByRole("button", { name: "Customer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Customer" });
  await dialog.getByLabel("Search by name").fill("Pat Mur");
  await dialog.getByRole("button", { name: "Search" }).click();
  await dialog.getByRole("button", { name: /Pat Murphy/ }).click();
  await expect(page.getByRole("button", { name: "Customer: Pat Murphy" })).toBeVisible();

  await page.getByRole("button", { name: /^Tea bags/ }).click();
  await page.getByRole("button", { name: "Pay €10.00" }).first().click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /^Exact/ }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  // The next sale starts with no customer.
  await expect(page.getByRole("button", { name: "Customer", exact: true })).toBeVisible();

  // A second customer made at the till, with consent ticked.
  await page.getByRole("button", { name: "Customer", exact: true }).click();
  await dialog.getByRole("button", { name: "New customer" }).click();
  await dialog.getByLabel(/^Name/).fill("Siobhan Kelly");
  // A bad VAT number is marked on its own field, and the other fields keep what was typed.
  await dialog.getByLabel(/^VAT number/).fill("IE1234567X");
  await dialog.getByRole("button", { name: "Add and use" }).click();
  await expect(dialog.getByLabel(/^VAT number/)).toBeFocused();
  await expect(dialog.getByText("Enter a valid VAT number, for example IE6388047V.")).toBeVisible();
  await dialog.getByLabel(/^VAT number/).fill("");
  await dialog.getByLabel("Email", { exact: true }).fill("pat@example.com");
  await dialog.getByRole("button", { name: "Add and use" }).click();
  await expect(dialog.getByText(/already exists/)).toBeVisible();
  await dialog.getByLabel("Email", { exact: true }).fill("siobhan@example.com");
  await dialog.getByLabel("Customer agrees to marketing emails").check();
  await dialog.getByRole("button", { name: "Add and use" }).click();
  await expect(page.getByRole("button", { name: "Customer: Siobhan Kelly" })).toBeVisible();

  // Back office: both are listed, Siobhan has consent, Pat's history has the sale once it syncs.
  await page.goto(`/o/${orgId}/customers?q=siobhan`);
  await expect(page.getByRole("row", { name: /Siobhan Kelly/ })).toContainText("Agreed");
  await page.goto(`/o/${orgId}/customers?q=pat`);
  await page.getByRole("link", { name: "Pat Murphy" }).click();
  await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("row", { name: /€10\.00/ })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 60_000 });

  // Consent is recorded with a timestamp, then withdrawn.
  await page.getByRole("button", { name: "Record consent now" }).click();
  await expect(page.getByText(/^Agreed /).first()).toBeVisible();
  await page.getByRole("button", { name: "Withdraw consent" }).click();
  await expect(page.getByText("No consent")).toBeVisible();

  // Export: everything held, including the sale.
  const customerUrl = page.url().split("?")[0]!;
  const exported = await page.request.get(`${customerUrl}/export?format=json`);
  expect(exported.status()).toBe(200);
  const body = (await exported.json()) as {
    customer: { name: string; vat_number: string };
    sales: unknown[];
  };
  expect(body.customer).toMatchObject({ name: "Pat Murphy", vat_number: "IE6388047V" });
  expect(body.sales).toHaveLength(1);
  const csv = await page.request.get(`${customerUrl}/export?format=csv`);
  expect(csv.headers()["content-type"]).toContain("text/csv");

  // Erasure: personal data gone, the sale stays in the history.
  await page.getByText("Delete personal data", { exact: true }).click();
  await page.getByRole("button", { name: "Yes, delete personal data" }).click();
  await expect(page.getByRole("heading", { name: "Deleted customer" })).toBeVisible();
  await expect(page.getByText("Personal data deleted.")).toBeVisible();
  await expect(page.getByRole("row", { name: /€10\.00/ })).toBeVisible();
  await page.goto(`/o/${orgId}/customers?q=pat`);
  await expect(page.getByText("No customers match.")).toBeVisible();
});
