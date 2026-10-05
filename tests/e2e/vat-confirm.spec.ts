import { expect, test } from "@playwright/test";
import { openDashboard, signUpAndEnrol, uniqueEmail } from "./helpers";

// Needs the local Supabase stack (`supabase start`) and its .env.local values.

test("an owner reviews the VAT rates in Settings and confirms them", async ({ page }) => {
  await signUpAndEnrol(page, uniqueEmail("vat-confirm"), "E2E VAT confirm");
  const orgId = await openDashboard(page, { type: "Café (counter service)" });

  await page.goto(`/o/${orgId}/settings`);
  await page.getByRole("link", { name: "VAT rates" }).click();
  await expect(page.getByRole("heading", { name: "VAT rates" })).toBeVisible();

  await expect(page.getByRole("row", { name: /Standard.*23%/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Catering.*9%/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Zero rate.*0%/ })).toBeVisible();
  await expect(page.getByText("Not confirmed yet.")).toBeVisible();

  await page.getByRole("button", { name: "I have checked these VAT rates" }).click();
  await expect(page.getByRole("status")).toHaveText("Thank you. Your confirmation is saved.");
  await expect(page.getByText(/^Confirmed on /)).toBeVisible();
});
