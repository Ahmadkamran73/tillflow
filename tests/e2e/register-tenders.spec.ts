import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import {
  hydrated,
  openDashboard,
  openTill,
  signUpAndEnrol,
  uniqueEmail,
  unlockTill,
} from "./helpers";

// Needs the local Supabase stack (`supabase start`) and its .env.local values (DIRECT_URL is how
// the test looks at the server's tables, as an administrator). Card is the shop's own terminal:
// the till only records the tender, so every "approval" here is just the cashier tapping a button.

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(180_000);

async function setup(page: Page, label: string, businessType?: string) {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await signUpAndEnrol(page, uniqueEmail(label), `E2E tenders ${label}`);
  const orgId = await openDashboard(page);
  // A café takes tips; the preset follows the shop's business type (read when the till loads).
  if (businessType)
    await sql`update organisations set business_type = ${businessType} where id = ${orgId}`;
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("12.34");
  if (!businessType) await page.getByLabel("Barcode").fill("5012345678900"); // cafés have no barcode field
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
  await openTill(page, orgId);
  return orgId;
}

const tile = (page: Page) => page.getByRole("button", { name: /^Tea bags/ });
const choose = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).click();
const dialog = (page: Page) => page.getByRole("dialog");

/** Puts one Tea bags (12.34) on the sale and opens the payment screen. */
async function startPayment(page: Page) {
  await tile(page).click();
  await page.getByRole("button", { name: "Pay €12.34" }).first().click();
  await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
}

const payments = (orgId: string) => sql`
  select p.method, p.label, p.amount_cents, p.tendered_cents, p.change_cents, p.tip_cents,
         p.provider_ref, s.amount_due_cents, s.cash_rounding_cents
  from payments p join sales s on s.id = p.sale_id
  where p.org_id = ${orgId} order by p.method`;

const waitForSales = (orgId: string, n: number) =>
  expect
    .poll(
      async () => (await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n,
      { timeout: 60_000 },
    )
    .toBe(n);

test("card only: exact amount, optional reference, no rounding, no change", async ({ page }) => {
  const orgId = await setup(page, "cardonly");
  await startPayment(page);
  await choose(page, "Card");
  await expect(page.getByLabel("Card amount")).toHaveValue("12.34"); // defaults to the exact amount due
  await page.getByLabel(/Terminal receipt reference/).fill("AUTH 123456");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await expect(page.getByText("Change due: €0.00")).toBeVisible();

  await waitForSales(orgId, 1);
  const rows = await payments(orgId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    method: "card",
    label: "Card",
    amount_cents: 1234,
    tendered_cents: 1234,
    change_cents: 0,
    tip_cents: 0,
    provider_ref: "AUTH 123456",
    amount_due_cents: 1234,
    cash_rounding_cents: 0,
  });
});

test("split card + cash: rounding only on the cash share, change only from cash", async ({
  page,
}) => {
  const orgId = await setup(page, "split");
  await startPayment(page);
  await choose(page, "Card");
  await page.getByLabel("Card amount").fill("5");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await expect(page.getByText("Still to pay", { exact: true })).toBeVisible();
  await choose(page, "Cash");
  await expect(page.getByText("Cash due: €7.35")).toBeVisible(); // 7.34 rounds to 7.35
  await page.getByRole("button", { name: "€10.00", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await expect(page.getByText("Change due: €2.65")).toBeVisible();

  await waitForSales(orgId, 1);
  const rows = await payments(orgId);
  expect(rows.map((r) => [r.method, r.amount_cents, r.tendered_cents, r.change_cents])).toEqual([
    ["card", 500, 500, 0],
    ["cash", 735, 1000, 265],
  ]);
  expect(rows[0]).toMatchObject({ amount_due_cents: 1235, cash_rounding_cents: 1 });
});

test("voucher + card: more than is left on a card is refused (no change from card)", async ({
  page,
}) => {
  const orgId = await setup(page, "voucher");
  await startPayment(page);
  await choose(page, "Voucher");
  await page.getByLabel("Voucher amount").fill("4");
  await page.getByLabel(/Voucher number/).fill("V-0042");
  await page.getByRole("button", { name: "Add voucher" }).click();
  await choose(page, "Card");
  await page.getByLabel("Card amount").fill("9");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await expect(dialog(page).getByRole("alert")).toContainText("Change is only given from cash");
  await page.getByLabel("Card amount").fill("8.34");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();

  await waitForSales(orgId, 1);
  const rows = await payments(orgId);
  expect(rows.map((r) => [r.method, r.amount_cents, r.provider_ref])).toEqual([
    ["card", 834, null],
    ["voucher", 400, "V-0042"],
  ]);
});

test("a card number typed as the reference is refused on screen and never stored", async ({
  page,
}) => {
  const orgId = await setup(page, "pan");
  await startPayment(page);
  await choose(page, "Card");
  for (const pan of ["4111111111111111", "4111 1111 1111 1111"]) {
    await page.getByLabel(/Terminal receipt reference/).fill(pan);
    await page.getByRole("button", { name: "Approved on terminal" }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("looks like a card number");
  }
  await expect(page.getByRole("button", { name: "Complete sale" })).toBeDisabled();
  // An approval code with letters and a short number is fine.
  await page.getByLabel(/Terminal receipt reference/).fill("A1B2C3 123456");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();

  await waitForSales(orgId, 1);
  const refs = await sql`select provider_ref from payments where org_id = ${orgId}`;
  expect(refs.map((r) => r.provider_ref)).toEqual(["A1B2C3 123456"]);
});

test("void a card payment before completing: the balance comes back and the sale is not stored", async ({
  page,
}) => {
  const orgId = await setup(page, "void");
  await startPayment(page);
  await choose(page, "Card");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await expect(page.getByRole("button", { name: "Complete sale" })).toBeEnabled();
  await page.getByRole("button", { name: /^Remove Card/ }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "void it on the card terminal" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete sale" })).toBeDisabled();
  await expect(dialog(page)).toContainText("€12.34");
  await page.getByRole("button", { name: "Cancel" }).click();
  expect((await sql`select count(*)::int as n from payments where org_id = ${orgId}`)[0]!.n).toBe(
    0,
  );
});

test("a card approved on the terminal is kept when the payment screen is closed and reopened", async ({
  page,
}) => {
  const orgId = await setup(page, "draft");
  await startPayment(page);
  await choose(page, "Card");
  await page.getByLabel("Card amount").fill("5");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Cancel" }).click(); // closes the screen; the payment is kept for this cart
  await page.getByRole("button", { name: "Pay €12.34" }).first().click();
  await expect(dialog(page).getByRole("list", { name: "Payments taken" })).toContainText("€5.00");
  expect((await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n).toBe(0);
});

test("café: a tip on card is stored beside the payment, outside the sale total", async ({
  page,
}) => {
  const orgId = await setup(page, "cafetip", "cafe");
  await startPayment(page);
  await choose(page, "Card");
  await page.getByLabel(/^Tip/).fill("1.50");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();

  await waitForSales(orgId, 1);
  const [row] = await payments(orgId);
  expect(row).toMatchObject({
    method: "card",
    amount_cents: 1234,
    tip_cents: 150,
    amount_due_cents: 1234,
  });
});

test("a shop that does not take tips shows no tip field", async ({ page }) => {
  await setup(page, "notip");
  await startPayment(page);
  await choose(page, "Card");
  await expect(page.getByLabel(/^Tip/)).toHaveCount(0);
});

test("offline: a card sale made with no connection syncs once, with its payment", async ({
  page,
  context,
}) => {
  const orgId = await setup(page, "offlinecard");
  await expect(tile(page)).toBeVisible();
  await context.setOffline(true);
  await startPayment(page);
  await choose(page, "Card");
  await page.getByLabel(/Terminal receipt reference/).fill("OFF 777");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Offline (1 waiting)" })).toBeVisible();
  expect((await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n).toBe(0);

  await context.setOffline(false);
  await waitForSales(orgId, 1);
  const rows = await payments(orgId);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ method: "card", amount_cents: 1234, provider_ref: "OFF 777" });

  // The back office sees it in today's totals per payment type.
  await page.goto(`/o/${orgId}/sales`);
  const totals = page.locator("section[aria-labelledby='by-tender']");
  await expect(totals).toContainText("Card");
  await expect(totals).toContainText("€12.34");
});

test("a reload keeps the sale and the card approved on the terminal; a finished sale does not come back", async ({
  page,
}) => {
  const orgId = await setup(page, "reload");
  await startPayment(page);
  await choose(page, "Card");
  await page.getByLabel("Card amount").fill("5");
  await page.getByRole("button", { name: "Approved on terminal" }).click();

  await page.reload(); // the till locks on load; the sale in progress is still there
  await unlockTill(page);
  await page.getByRole("button", { name: "Pay €12.34" }).first().click();
  await expect(dialog(page).getByRole("list", { name: "Payments taken" })).toContainText("€5.00");
  await choose(page, "Cash");
  await page.getByRole("button", { name: /^Exact/ }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await waitForSales(orgId, 1);

  // Reloading on the finished sale must not bring its cart back (it would be rung up twice).
  await page.reload();
  await unlockTill(page);
  await expect(page.getByText("Nothing in this sale yet")).toBeVisible();
  expect((await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n).toBe(1);
});
