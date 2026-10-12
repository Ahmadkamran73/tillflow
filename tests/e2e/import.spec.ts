import { expect, test, type Page } from "@playwright/test";
import { enIE } from "@/lib/i18n/en-IE";
import { hydrated, openDashboard, signUpAndEnrol, uniqueEmail } from "./helpers";

// One simulated account (a general store owner) imports a file with good and bad rows, then undoes
// it. Database rules, roles and cross-shop access are in tests/rls/imports.test.ts.

const CSV = [
  "Name,Price,SKU,Barcode,VAT rate,Category,Opening stock",
  "Brennans Bread,2.49,BRD1,5390001,0,Grocery,12",
  "Milk 1L,1.35,MLK1,5390002,0,Grocery,30",
  "Broken price,abc,BAD1,5390003,23,Grocery,1",
  "Same barcode as bread,3.00,DUP1,5390001,23,Grocery,1",
  "Cola,1.80,COLA,5390005,23,Drinks,6",
].join("\n");

async function upload(page: Page, name: string, body: string) {
  await page
    .locator("#import-file")
    .setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(body) });
  await page.getByRole("button", { name: enIE["import.upload.button"] }).click();
}

test("import: upload, map, check the problem rows, import in the background, undo", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await signUpAndEnrol(page, uniqueEmail("import"), "E2E import");
  const orgId = await openDashboard(page, { type: enIE["businessType.general"] });

  await page.goto(`/o/${orgId}/products/import`);
  await hydrated(page);

  // A SQL dump is refused with a plain explanation, and nothing is stored.
  await upload(page, "dump.sql", "INSERT INTO products VALUES (1);");
  await expect(page.locator("p[role=alert]")).toContainText("never run SQL");
  await expect(page.locator("#import-file")).toBeVisible();

  await upload(page, "products.csv", CSV);
  await expect(page.getByRole("heading", { name: enIE["import.step.map"] })).toBeVisible();
  // Columns were matched by name.
  await expect(page.locator("#map-name")).toHaveValue("Name");
  await expect(page.locator("#map-price")).toHaveValue("Price");
  await expect(page.locator("#map-barcode")).toHaveValue("Barcode");

  // A match can be saved, applied again and deleted.
  await page.locator("#import-save-name").fill("Shop file");
  await page.getByRole("button", { name: enIE["import.map.save"] }).click();
  await expect(page.getByRole("status").first()).toHaveText(enIE["import.map.saved.ok"]);
  await page.locator("#import-saved").selectOption({ label: "Shop file" });
  await expect(page.getByRole("status").first()).toHaveText("Applied the saved match Shop file.");
  await page.getByRole("button", { name: enIE["import.map.delete"] }).click();
  await expect(page.getByRole("status").first()).toHaveText("Deleted the saved match Shop file.");
  await expect(page.locator("#import-saved option")).toHaveCount(1);
  await page.getByRole("button", { name: enIE["import.map.next"] }).click();

  await expect(page.getByRole("heading", { name: enIE["import.step.check"] })).toBeVisible();
  await expect(page.getByText("3 rows are ready to import.")).toBeVisible();
  await expect(page.getByText("2 rows have problems and will be skipped.")).toBeVisible();
  const problems = page.getByRole("region", { name: enIE["import.check.errorsTitle"] });
  await expect(problems).toContainText("Enter a price like 3.50.");
  await expect(problems).toContainText("already used on row 2");

  // The problem rows can be downloaded to fix.
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: enIE["import.check.download"] }).click();
  expect((await download).suggestedFilename()).toBe("import-problems.csv");

  await page.getByRole("button", { name: enIE["import.start"] }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "Finished: 3 added, 0 updated, 0 skipped, 2 with problems.",
    {
      timeout: 90_000,
    },
  );

  // The products are in the list (checked in a second tab so this screen stays on the result).
  const list = await page.context().newPage();
  await list.goto(`/o/${orgId}/products`);
  await expect(list.getByText("Brennans Bread")).toBeVisible();
  await expect(list.getByText("Milk 1L")).toBeVisible();
  await expect(list.getByText("Cola")).toBeVisible();
  await expect(list.getByText("Broken price")).toHaveCount(0);

  // Undo is offered for 24 hours; the products go from the list (archived, never deleted).
  await page.getByRole("button", { name: enIE["import.progress.undo"] }).click();
  await expect(page.getByRole("status").first()).toContainText("Import undone: 3 changes reverted");
  await list.reload();
  await expect(list.getByText("Brennans Bread")).toHaveCount(0);
});
