import { expect, test } from "@playwright/test";
import { businessTypes, presets } from "@/config/business-type-presets";
import { enIE } from "@/lib/i18n/en-IE";
import { openDashboard, signUpAndEnrol, uniqueEmail } from "./helpers";

// Needs the local Supabase stack (`supabase start`) and its .env.local values.

for (const type of businessTypes) {
  test(`a ${type} owner completes onboarding and sees its starter categories`, async ({ page }) => {
    await signUpAndEnrol(page, uniqueEmail(`onb-${type}`), `E2E ${type}`);
    await openDashboard(page, {
      type: enIE[`businessType.${type}`],
      vat: "IE 1234567T",
      tills: "2",
    });

    const categories = page.getByRole("region", { name: "Your categories" }).getByRole("listitem");
    await expect(categories).toHaveText(presets[type].starterCategories.map((c) => c.name));

    // Onboarding happens once: going back lands on the dashboard.
    await page.goto("/onboarding");
    await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/dashboard$/);
  });
}

test("a wrong VAT number or missing type stops the wizard on that step", async ({ page }) => {
  await signUpAndEnrol(page, uniqueEmail("onb-invalid"), "E2E Invalid");
  await page.getByLabel("VAT number (optional)").fill("IE1234567A");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Enter a valid Irish VAT number")).toBeVisible();

  await page.getByLabel("VAT number (optional)").fill("");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Choose a business type.")).toBeVisible();
});

test("changing business type later keeps old categories and adds the new starters", async ({
  page,
}) => {
  await signUpAndEnrol(page, uniqueEmail("onb-switch"), "E2E Switch");
  const orgId = await openDashboard(page, { type: "Café (counter service)" });

  await page.goto(`/o/${orgId}/settings/business-type`);
  await page.getByText("Restaurant (table service)", { exact: true }).click();
  await page.getByRole("button", { name: "Save business type" }).click();
  await expect(page.getByRole("status")).toHaveText("Business type saved.");
  await expect(page.getByRole("radio", { name: "Restaurant (table service)" })).toBeChecked();

  await page.goto(`/o/${orgId}/dashboard`);
  const categories = page.getByRole("region", { name: "Your categories" }).getByRole("listitem");
  await expect(categories).toHaveText([
    ...presets.cafe.starterCategories.map((c) => c.name),
    ...presets.restaurant.starterCategories.map((c) => c.name),
  ]);
});
