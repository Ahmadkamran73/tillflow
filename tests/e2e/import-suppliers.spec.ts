import { expect, test } from "@playwright/test";
import { enIE } from "@/lib/i18n/en-IE";
import { hydrated, openDashboard, signUpAndEnrol, uniqueEmail } from "./helpers";

// Suppliers: import a file (one bad row), see them in the Suppliers list, undo. Database rules are in
// tests/rls/imports-suppliers.test.ts.
test("import: suppliers appear in the Suppliers list and undo archives them", async ({ page }) => {
  test.setTimeout(180_000);
  await signUpAndEnrol(page, uniqueEmail("import-suppliers"), "E2E import suppliers");
  const orgId = await openDashboard(page, { type: enIE["businessType.general"] });

  // The Suppliers page starts empty and offers the import.
  await page.goto(`/o/${orgId}/suppliers`);
  await expect(page.getByRole("heading", { name: "No suppliers yet." })).toBeVisible();
  await page.getByRole("link", { name: enIE["import.link.suppliers"] }).click();
  await hydrated(page);
  await expect(page.getByRole("heading", { name: enIE["import.title.suppliers"] })).toBeVisible();

  const csv = [
    "Supplier Name,Email,Phone,VAT number",
    "Dairy Direct Ltd,orders@dairydirect.example,021 123 4567,IE6388047V",
    "Bakery Wholesale,,087 555 0101,",
    "Broken Email Co,not-an-email,,",
    "dairy direct ltd,,,",
  ].join("\n");
  await page.locator("#import-file").setInputFiles({
    name: "suppliers.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: enIE["import.upload.button"] }).click();
  await expect(page.getByRole("heading", { name: enIE["import.step.map"] })).toBeVisible();
  await expect(page.locator("#map-name")).toHaveValue("Supplier Name"); // matched by name
  await page.getByRole("button", { name: enIE["import.map.next"] }).click();

  await expect(page.getByRole("heading", { name: enIE["import.step.check"] })).toBeVisible();
  await expect(page.getByText("2 rows are ready to import.")).toBeVisible();
  await expect(page.getByText("2 suppliers will be added.")).toBeVisible();
  const problems = page.getByRole("region", { name: enIE["import.check.errorsTitle"] });
  await expect(problems).toContainText("valid email");
  await expect(problems).toContainText("already used on row 2");
  await page.getByRole("button", { name: enIE["import.start"] }).click();
  await expect(page.getByRole("status").first()).toContainText("Finished: 2 added", {
    timeout: 90_000,
  });

  await page.goto(`/o/${orgId}/suppliers`);
  await expect(page.getByRole("row", { name: /Dairy Direct Ltd/ })).toContainText("021 123 4567");
  await expect(page.getByRole("row", { name: /Bakery Wholesale/ })).toBeVisible();
  await expect(page.getByText("Broken Email Co")).toHaveCount(0);

  // Undo from the import page's result isn't available after leaving it, so import again and undo.
  await page.goto(`/o/${orgId}/products/import?type=suppliers`);
  await hydrated(page);
  await page.locator("#import-file").setInputFiles({
    name: "more.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(["Name", "Fresh Fruit Co"].join("\n")),
  });
  await page.getByRole("button", { name: enIE["import.upload.button"] }).click();
  await page.getByRole("button", { name: enIE["import.map.next"] }).click();
  await expect(page.getByRole("heading", { name: enIE["import.step.check"] })).toBeVisible();
  await page.getByRole("button", { name: enIE["import.start"] }).click();
  await expect(page.getByRole("status").first()).toContainText("Finished: 1 added", {
    timeout: 90_000,
  });
  await page.getByRole("button", { name: enIE["import.progress.undo"] }).click();
  await expect(page.getByRole("status").first()).toContainText("Import undone: 1 changes reverted");
  await page.goto(`/o/${orgId}/suppliers`);
  await expect(page.getByText("Fresh Fruit Co")).toHaveCount(0);
  await expect(page.getByRole("row", { name: /Dairy Direct Ltd/ })).toBeVisible();
});
