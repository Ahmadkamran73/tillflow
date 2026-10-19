import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import { hydrated, openDashboard, openTill, signUpAndEnrol, uniqueEmail } from "./helpers";

// Needs the local Supabase stack and .env.local (DIRECT_URL looks at the server's tables as an
// administrator). A café order: two modified coffees, a take-away sandwich and a soft drink.

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(120_000);

const save = (page: Page) => page.getByRole("button", { name: "Save product" }).click();

async function product(
  page: Page,
  orgId: string,
  p: {
    name: string;
    price: string;
    category: string;
    vat: "CATERING" | "STANDARD";
    takeaway?: "ZERO";
    allergen?: string;
    group?: string;
  },
) {
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill(p.name);
  await page.getByLabel("Category").selectOption({ label: p.category });
  await page.getByLabel("VAT rate", { exact: true }).selectOption(p.vat);
  if (p.takeaway) await page.getByLabel("VAT rate when taken away").selectOption(p.takeaway);
  await page.getByLabel("Price (including VAT)").fill(p.price);
  if (p.allergen)
    await page.getByRole("group", { name: "Allergens" }).getByLabel(p.allergen).check();
  if (p.group)
    await page.getByRole("group", { name: "Modifier groups" }).getByLabel(p.group).check();
  await save(page);
  await expect(page).toHaveURL(/\/products\?saved=1$/);
}

test("café order: modified coffees, take-away sandwich, soft drink, tickets and VAT by rate", async ({
  page,
}) => {
  // Every window.print() is recorded with what the print area held, so tickets can be read back.
  await page.addInitScript(() => {
    const w = window as unknown as { __prints: string[] };
    w.__prints = [];
    window.print = () => {
      w.__prints.push(document.getElementById("print-receipt")?.textContent ?? "");
    };
  });
  await signUpAndEnrol(page, uniqueEmail("cafe"), "E2E cafe order");
  const orgId = await openDashboard(page, { type: "Café (counter service)" });

  await page.goto(`/o/${orgId}/products/modifiers/new`);
  await hydrated(page);
  await page.getByLabel("Group name").fill("Size");
  await page.getByLabel("Minimum choices").fill("1");
  await page.getByLabel("Maximum choices").fill("1");
  await page.getByLabel("Option name").fill("Small");
  await page.getByRole("button", { name: "Add option" }).click();
  await page.getByLabel("Option name").nth(1).fill("Large");
  await page.getByLabel("Extra price (can be negative)").nth(1).fill("0.50");
  await page.getByRole("button", { name: "Save group" }).click();
  await expect(page.getByRole("status")).toHaveText("Group saved.");

  await product(page, orgId, {
    name: "Latte",
    price: "4.50",
    category: "Hot drinks",
    vat: "CATERING",
    allergen: "Milk",
    group: "Size",
  });
  await product(page, orgId, {
    name: "Ham sandwich",
    price: "5.00",
    category: "Food",
    vat: "CATERING",
    takeaway: "ZERO",
    allergen: "Eggs",
  });
  await product(page, orgId, {
    name: "Cola",
    price: "2.50",
    category: "Cold drinks",
    vat: "STANDARD",
  });

  await openTill(page, orgId);

  // Tickets: Cold drinks are made at the bar, everything else in the kitchen (default).
  await page.getByRole("button", { name: /^Tickets/ }).click();
  await page.getByLabel("Station for Hot drinks").selectOption("bar");
  await page.getByLabel("Station for Cold drinks").selectOption("bar");
  for (const station of ["Bar", "Kitchen"]) {
    const setUp = page.getByRole("button", { name: `Set up ${station} printer` });
    await setUp.click();
    if (station === "Bar") {
      // The test-print result is announced inside the dialog, not behind it.
      await page.getByRole("button", { name: "Test print" }).click();
      await expect(page.getByRole("dialog").getByRole("status")).not.toBeEmpty();
    }
    await page.getByRole("button", { name: "Save", exact: true }).click();
    // Back on the Stations dialog, focus stays inside it (not lost to the page behind).
    await expect(page.getByRole("heading", { name: "Kitchen and bar tickets" })).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")))
      .toBe(true);
  }
  await page.getByRole("button", { name: "Close" }).click();

  // Allergen list: lists the declared allergens and announces the print result inside the dialog.
  await page.getByRole("button", { name: "Allergens", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Latte");
  await expect(page.getByRole("dialog")).toContainText("Ham sandwich");
  await page.getByRole("button", { name: "Print allergen list" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).not.toBeEmpty();
  await page.getByRole("button", { name: "Close" }).click();

  // The size group is required: Add stays disabled until one is chosen.
  const latte = () => page.getByRole("button", { name: /^Latte/ });
  await expect(latte()).toContainText("Milk");
  await latte().click();
  const add = page.getByRole("dialog").getByRole("button", { name: /^Add/ });
  await expect(add).toBeDisabled();
  await page.getByRole("button", { name: /^Large/ }).click();
  await add.click();
  await latte().click();
  await page.getByRole("button", { name: /^Large/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: /^Add/ }).click();

  await page.getByRole("button", { name: /^Ham sandwich/ }).click();
  await page.getByRole("button", { name: /^Cola/ }).click();
  await page.getByRole("button", { name: "Take away", exact: true }).click();
  await page.getByLabel("Order name (optional)").fill("Aoife");

  // Two lattes at 5.00 (large), sandwich 5.00, cola 2.50.
  await page.getByRole("button", { name: "Pay €17.50" }).first().click();
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByLabel(/^Tip/).fill("1.00");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();

  // Bar ticket (lattes, cola) and kitchen ticket (sandwich), both with the name and TAKE AWAY.
  const prints = await page.evaluate(() => (window as unknown as { __prints: string[] }).__prints);
  // Browser-mode tickets go out as one print job, bar first.
  const job = prints.find((p) => p.startsWith("BAR"))!;
  const [bar, kitchen] = job.split("KITCHEN");
  expect(bar).toContain("1 x Latte");
  expect(bar).toContain("+ Large");
  expect(bar).toContain("1 x Cola");
  expect(bar).toContain("AOIFE");
  expect(bar).toContain("TAKE AWAY");
  expect(bar).not.toContain("sandwich");
  expect(kitchen).toContain("1 x Ham sandwich");
  expect(kitchen).toContain("ALLERGENS: Eggs");
  const receipt = prints.at(-1)!;
  expect(receipt).toContain("Order: Aoife");
  expect(receipt).toContain("VAT 9%");
  expect(receipt).toContain("VAT 0%");
  expect(receipt).toContain("VAT 23%");

  // Server: VAT by rate, each line at its own rate. Coffee 5.00 at 9% -> 41c each, cola 2.50 at 23% -> 47c.
  await expect
    .poll(
      async () => (await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n,
      {
        timeout: 60_000,
      },
    )
    .toBe(1);
  const lines = await sql`
    select l.tax_rate_bp, l.vat_cents, l.gross_cents, l.qty
    from sale_lines l where l.org_id = ${orgId} and l.kind = 'item' order by l.line_no`;
  expect(lines.map((l) => [l.tax_rate_bp, l.gross_cents])).toEqual([
    [900, 500],
    [900, 500],
    [0, 500],
    [2300, 250],
  ]);
  expect(lines.map((l) => l.vat_cents)).toEqual([41, 41, 0, 47]);
  const [sale] =
    await sql`select vat_cents, amount_due_cents, mode from sales where org_id = ${orgId}`;
  expect(sale).toMatchObject({ vat_cents: 129, amount_due_cents: 1750, mode: "take_away" });
  const [pay] = await sql`select tip_cents from payments where org_id = ${orgId}`;
  expect(pay!.tip_cents).toBe(100);
});
