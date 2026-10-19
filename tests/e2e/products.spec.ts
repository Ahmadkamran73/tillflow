import { expect, test, type Page } from "@playwright/test";
import { enIE } from "@/lib/i18n/en-IE";
import { hydrated, openDashboard, signUpAndEnrol, uniqueEmail } from "./helpers";

// Needs the local Supabase stack (`supabase start`) and its .env.local values.

async function setUp(
  page: Page,
  type: "general" | "electronics" | "clothing" | "cafe" | "restaurant",
) {
  await signUpAndEnrol(page, uniqueEmail(`prod-${type}`), `E2E products ${type}`);
  const orgId = await openDashboard(page, { type: enIE[`businessType.${type}`] });
  return orgId;
}

const save = (page: Page) => page.getByRole("button", { name: "Save product" }).click();

test("general: create, search, filter, edit, and a duplicate barcode is refused", async ({
  page,
}) => {
  const orgId = await setUp(page, "general");
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);

  // Only the general-store fields show.
  await expect(page.getByLabel("Re-turn deposit")).toBeVisible();
  await expect(page.getByLabel("Brand")).toHaveCount(0);
  await expect(page.getByLabel("Course")).toHaveCount(0);

  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Category").selectOption({ label: "Grocery" });
  await page.getByLabel("Price (including VAT)").fill("12.30");
  // Live VAT split from the money library: 23% standard rate.
  await expect(page.locator("#v-0-vat")).toHaveText("Ex VAT €10.00 · VAT €2.30 at 23%");
  await page.getByLabel("Barcode").fill("5012345678900");
  await page.getByLabel("Opening stock").fill("12");
  await save(page);

  await expect(page).toHaveURL(/\/products\?saved=1$/);
  await expect(page.getByRole("status")).toHaveText("Product saved.");
  const row = page.getByRole("row", { name: /Tea bags/ });
  await expect(row).toContainText("€12.30");
  await expect(row).toContainText("5012345678900");
  await expect(row).toContainText("12");

  // Search by exact barcode, by name, and filter by category.
  await page.getByLabel("Search by name, SKU or barcode").fill("5012345678900");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: "Tea bags" })).toBeVisible();
  await page.getByLabel("Search by name, SKU or barcode").fill("nothing like this");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No products match your search.")).toBeVisible();
  await page.getByLabel("Search by name, SKU or barcode").fill("tea");
  await page.getByLabel("Category").selectOption({ label: "Drinks" });
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No products match your search.")).toBeVisible();
  await page.getByLabel("Category").selectOption({ label: "Grocery" });
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("link", { name: "Tea bags" })).toBeVisible();

  // Edit the price.
  await page.getByRole("link", { name: "Tea bags" }).click();
  await hydrated(page);
  await expect(page.getByLabel("Price (including VAT)")).toHaveValue("12.30");
  await page.getByLabel("Price (including VAT)").fill("13");
  await save(page);
  await expect(page.getByRole("row", { name: /Tea bags/ })).toContainText("€13.00");

  // The same barcode on another product is refused, naming the field.
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Coffee");
  await page.getByLabel("Price (including VAT)").fill("5");
  await page.getByLabel("Barcode").fill("5012345678900");
  await save(page);
  await expect(page.getByText("This barcode is used by another product.")).toBeVisible();
  await expect(page.getByLabel("Barcode")).toBeFocused();
  await expect(page).toHaveURL(/\/products\/new$/);

  // Client-side checks: a bad price needs no round trip.
  await page.getByLabel("Barcode").fill("");
  await page.getByLabel("Price (including VAT)").fill("5,00");
  await save(page);
  await expect(page.getByText("Enter a price like 3.50.")).toBeVisible();
});

test("electronics: brand, model and warranty are saved and shown again", async ({ page }) => {
  const orgId = await setUp(page, "electronics");
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await expect(page.getByLabel("Re-turn deposit")).toHaveCount(0);

  await page.getByLabel("Name").fill("Phone X");
  await page.getByLabel("Category").selectOption({ label: "Phones" });
  await page.getByLabel("Price (including VAT)").fill("599");
  await page.getByLabel("Brand").fill("Acme");
  await page.getByLabel("Model").fill("X1");
  await page.getByLabel("Warranty (months)").fill("24");
  await page.getByLabel("Ask for a serial or IMEI on every sale").check();
  await save(page);
  await expect(page.getByRole("row", { name: /Phone X/ })).toContainText("€599.00");

  await page.getByRole("link", { name: "Phone X" }).click();
  await hydrated(page);
  await expect(page.getByLabel("Brand")).toHaveValue("Acme");
  await expect(page.getByLabel("Warranty (months)")).toHaveValue("24");
  await expect(page.getByLabel("Ask for a serial or IMEI on every sale")).toBeChecked();
});

test("clothing: a 2 x 2 size and colour matrix makes 4 variants; removing a colour archives two", async ({
  page,
}) => {
  const orgId = await setUp(page, "clothing");
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await expect(page.getByLabel("Barcode")).toHaveCount(0); // no single-variant barcode: it is per row

  await page.getByLabel("Name").fill("Tee");
  const sizes = page.getByLabel("Sizes", { exact: true });
  await sizes.fill("S");
  await sizes.press("Enter");
  await sizes.fill("M");
  await sizes.press("Enter");
  const colours = page.getByLabel("Colours", { exact: true });
  await colours.fill("Black");
  await colours.press("Enter");
  await colours.fill("White");
  await colours.press("Enter");

  const table = page.getByRole("table", { name: /Variants/ });
  await expect(table.getByRole("row")).toHaveCount(5); // header + 4
  for (const v of ["S / Black", "S / White", "M / Black", "M / White"]) {
    await table.getByLabel(`Price (including VAT), ${v}`).fill("20");
  }
  await table.getByLabel("Barcode, S / Black").fill("TEE-S-BLK");
  await table.getByLabel("Opening stock, S / Black").fill("3");
  await expect(page.locator("#v-0-vat")).toHaveText("Ex VAT €16.26 · VAT €3.74 at 23%");
  await save(page);
  await expect(page.getByRole("row", { name: /Tee/ })).toContainText("4 variants");

  await page.getByRole("link", { name: "Tee" }).click();
  await hydrated(page);
  await expect(page.getByLabel("Price (including VAT), M / White")).toHaveValue("20.00");
  await page.getByRole("button", { name: "Remove White" }).click();
  await expect(page.getByRole("table", { name: /Variants/ }).getByRole("row")).toHaveCount(3);
  await save(page);
  await expect(page.getByRole("row", { name: /Tee/ })).toContainText("2 variants");

  // A missing price on a variant is caught on the matrix row.
  await page.getByRole("link", { name: "Tee" }).click();
  await hydrated(page);
  const sizes2 = page.getByLabel("Sizes", { exact: true });
  await sizes2.fill("L");
  await sizes2.press("Enter");
  await page.getByLabel("Price (including VAT), L / Black").fill("");
  await save(page);
  await expect(page.getByText("Enter a price like 3.50.")).toBeVisible();
});

test("cafe: a modifier group, allergens, catering VAT with a take-away rate", async ({ page }) => {
  const orgId = await setUp(page, "cafe");

  await page.goto(`/o/${orgId}/products/modifiers/new`);
  await hydrated(page);
  await page.getByLabel("Group name").fill("Milk");
  await page.getByLabel("Maximum choices").fill("1");
  await page.getByLabel("Option name").fill("Oat");
  await page.getByLabel("Extra price (can be negative)").fill("0.50");
  await page.getByRole("button", { name: "Add option" }).click();
  await page.getByLabel("Option name").nth(1).fill("Dairy");
  await page.getByRole("button", { name: "Save group" }).click();
  await expect(page.getByRole("status")).toHaveText("Group saved.");
  await expect(page.getByRole("link", { name: /Milk/ })).toContainText("Oat (€0.50), Dairy");

  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await expect(page.getByLabel("Barcode")).toHaveCount(0);
  await page.getByLabel("Name").fill("Latte");
  await page.getByLabel("Category").selectOption({ label: "Hot drinks" });
  await page.getByLabel("VAT rate", { exact: true }).selectOption("CATERING");
  await page.getByLabel("Price (including VAT)").fill("4.50");
  await page.getByRole("group", { name: "Allergens" }).getByLabel("Milk").check();
  await page.getByRole("group", { name: "Modifier groups" }).getByLabel("Milk").check();
  await save(page);
  await expect(page.getByRole("row", { name: /Latte/ })).toContainText("€4.50");

  await page.getByRole("link", { name: "Latte" }).click();
  await hydrated(page);
  await expect(page.getByRole("group", { name: "Allergens" }).getByLabel("Milk")).toBeChecked();
  await expect(
    page.getByRole("group", { name: "Allergens" }).getByLabel("Peanuts"),
  ).not.toBeChecked();
  await expect(
    page.getByRole("group", { name: "Modifier groups" }).getByLabel("Milk"),
  ).toBeChecked();
  // Hot drink: take-away defaults to catering (9%).
  await expect(page.getByLabel("VAT rate when taken away")).toHaveValue("CATERING");
});

test("restaurant: course and 14 allergens are offered", async ({ page }) => {
  const orgId = await setUp(page, "restaurant");
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await expect(page.getByRole("group", { name: "Allergens" }).getByRole("checkbox")).toHaveCount(
    14,
  );

  await page.getByLabel("Name").fill("Soup");
  await page.getByLabel("Category").selectOption({ label: "Starters" });
  await page.getByLabel("VAT rate", { exact: true }).selectOption("CATERING");
  await page.getByLabel("VAT rate when taken away").selectOption("ZERO");
  await page.getByLabel("Price (including VAT)").fill("7.50");
  await page.getByLabel("Course").selectOption("starter");
  await page.getByRole("group", { name: "Allergens" }).getByLabel("Celery").check();
  await save(page);
  await expect(page.getByRole("row", { name: /Soup/ })).toContainText("€7.50");

  await page.getByRole("link", { name: "Soup" }).click();
  await hydrated(page);
  await expect(page.getByLabel("Course")).toHaveValue("starter");
  await expect(page.getByRole("group", { name: "Allergens" }).getByLabel("Celery")).toBeChecked();
});
