import { expect, test, type Page } from "@playwright/test";
import { enIE } from "@/lib/i18n/en-IE";
import { hydrated, openDashboard, signUpAndEnrol, uniqueEmail } from "./helpers";

// One simulated account (a general store owner) walks the whole inventory flow.
// Reasons, roles and cross-shop access are covered by tests/rls/inventory.test.ts.

async function record(page: Page, reason: string, qty: string, note = "") {
  await page.getByLabel("Reason").selectOption({ label: reason });
  await page.locator("#qty").fill(qty);
  if (note) await page.locator("#note").fill(note);
  const sent = page.waitForResponse((r) => r.request().method() === "POST");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await sent;
  await expect(page.getByRole("status").first()).toHaveText("Saved.");
  await hydrated(page);
}

test("inventory: receive, damage, count, alert level, negative stock and valuation", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await signUpAndEnrol(page, uniqueEmail("inventory"), "E2E inventory");
  const orgId = await openDashboard(page, { type: enIE["businessType.general"] });

  // A product with a cost and 5 in opening stock.
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Milk");
  await page.getByLabel("Price (including VAT)").fill("2.00");
  await page.getByLabel("Cost (optional)").fill("1.00");
  await page.getByLabel("Opening stock").fill("5");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);

  await page.goto(`/o/${orgId}/inventory`);
  await expect(page.getByTestId("stock-value")).toHaveText("€5.00");
  await page.getByRole("link", { name: /Milk/ }).click();
  await hydrated(page);
  await expect(page.getByTestId("on-hand")).toHaveText("5");

  await record(page, "Received (delivery)", "10", "Friday delivery");
  await expect(page.getByTestId("on-hand")).toHaveText("15");
  await record(page, "Damaged or lost", "3", "Dropped");
  await expect(page.getByTestId("on-hand")).toHaveText("12");
  // A count of 4 records -8: the change is the count minus what the system showed.
  await record(page, "Stock count", "4");
  await expect(page.getByTestId("on-hand")).toHaveText("4");
  // A count equal to the system is refused, naming the field.
  await page.getByLabel("Reason").selectOption({ label: "Stock count" });
  await page.locator("#qty").fill("4");
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByText("nothing to record")).toBeVisible();

  const history = page.getByRole("table", { name: "Movement history" });
  await expect(history.getByRole("row")).toHaveCount(5); // header + opening, received, damage, count
  await expect(history).toContainText("Friday delivery");
  await expect(history).toContainText("-8");

  // Alert at 5: 4 on hand is low, the dashboard says so, and the Low stock filter finds it.
  await page.getByLabel("Alert when the product total is at or below").fill("5");
  await page.getByRole("button", { name: "Save alert level" }).click();
  await page.goto(`/o/${orgId}/inventory`);
  await expect(page.getByRole("row", { name: /Milk/ })).toContainText("Low");
  await expect(page.getByTestId("stock-value")).toHaveText("€4.00");
  await page.goto(`/o/${orgId}/dashboard`);
  await page.getByRole("link", { name: "1 product(s) low or out of stock" }).click();
  await expect(page.getByRole("row", { name: /Milk/ })).toBeVisible();

  // Selling past zero is allowed: stock below zero is highlighted and left out of the value.
  await page.getByRole("row", { name: /Milk/ }).getByRole("link").click();
  await expect(page).toHaveURL(/\/inventory\/[0-9a-f-]{36}$/);
  await hydrated(page);
  await record(page, "Other correction", "-10", "Sold before the delivery was entered");
  await expect(page.getByTestId("on-hand")).toContainText("-6");
  await page.goto(`/o/${orgId}/inventory?filter=negative`);
  await expect(page.getByRole("row", { name: /Milk/ })).toContainText("Below zero");
  await expect(page.getByTestId("stock-value")).toHaveText("€0.00");
  await expect(page.getByText("1 item(s) are below zero and are not valued.")).toBeVisible();
});
