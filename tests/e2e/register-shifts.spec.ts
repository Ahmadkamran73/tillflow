import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import {
  hydrated,
  makePairingCode,
  openDashboard,
  pairWithCode,
  setMyPin,
  signUpAndEnrol,
  TILL_NAME,
  TILL_PIN,
  uniqueEmail,
} from "./helpers";

// Needs the local Supabase stack and .env.local (DIRECT_URL lets the test read the server's tables).
config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(180_000);

/** A shop with one product and a paired till, unlocked but with NO shift open yet. */
async function setup(page: Page, label: string) {
  let printed = 0;
  await page.exposeFunction("countPrint", () => printed++);
  await page.addInitScript(() => {
    window.print = () => void (window as unknown as { countPrint(): void }).countPrint();
  });
  await signUpAndEnrol(page, uniqueEmail(label), `E2E shifts ${label}`);
  const orgId = await openDashboard(page);
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("10.00");
  await page.getByLabel("Barcode").fill("5012345678900");
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
  await setMyPin(page, orgId);
  await pairWithCode(page, await makePairingCode(page, orgId));
  await expect(page).toHaveURL(new RegExp(`/register/${orgId}$`));
  await page.getByRole("button", { name: new RegExp(`^${TILL_NAME}`) }).click();
  await page.getByLabel(`PIN for ${TILL_NAME}`).fill(TILL_PIN);
  await page.getByRole("button", { name: "Unlock" }).click();
  return { orgId, printCount: () => printed };
}

const openDialog = (page: Page) => page.getByRole("dialog", { name: "Open the shift" });

const waitFor = (fn: () => Promise<number>, want: number) =>
  expect.poll(fn, { timeout: 60_000 }).toBe(want);

test("selling waits for a shift; X-report; cash in/out; close 2.00 short prints and syncs the Z", async ({
  page,
}) => {
  const { orgId, printCount } = await setup(page, "z");

  // No shift: the till asks for a float first.
  await expect(openDialog(page)).toBeVisible();
  await openDialog(page)
    .getByLabel(/Float in the drawer/)
    .fill("abc");
  await openDialog(page).getByRole("button", { name: "Open shift" }).click();
  await expect(page.getByText(/Enter the float as an amount/)).toBeVisible();
  await openDialog(page)
    .getByLabel(/Float in the drawer/)
    .fill("100");
  await openDialog(page).getByRole("button", { name: "Open shift" }).click();
  await expect(openDialog(page)).toBeHidden();

  // One cash sale of 10.00.
  await page.getByRole("button", { name: /^Tea bags/ }).click();
  await page.getByRole("button", { name: "Pay €10.00" }).first().click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /^Exact/ }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();

  // Cash in 20.00 and out 5.00, each with a note (a note is required).
  await page.getByRole("button", { name: "Shift" }).click();
  await page.getByRole("button", { name: "Cash in" }).click();
  await page.getByLabel("Amount (€)").fill("20");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Add a note saying what the cash is for.")).toBeVisible();
  await page.getByLabel(/^Note/).fill("Change from the bank");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "Shift" }).click();
  await page.getByRole("button", { name: "Cash out" }).click();
  await page.getByLabel("Amount (€)").fill("5");
  await page.getByLabel(/^Note/).fill("Milk");
  await page.getByRole("button", { name: "Save" }).click();

  // X-report: expected 100 + 10 + 20 - 5 = 125.00. Nothing closes.
  await page.getByRole("button", { name: "Shift" }).click();
  await page.getByRole("button", { name: "X-report" }).click();
  const x = page.getByRole("dialog", { name: "X-report" });
  await expect(x.getByText("Expected in drawer")).toBeVisible();
  await expect(x.getByText("€125.00")).toBeVisible();
  await x.getByRole("button", { name: "Done" }).click();

  // Close, counting 123.00: 2.00 short. The Z prints on the spot.
  const printsBefore = printCount();
  await page.getByRole("button", { name: "Shift" }).click();
  await page.getByRole("button", { name: "Close shift" }).click();
  await page.getByLabel("Cash counted (€)").fill("123");
  await expect(page.getByText("Short €2.00")).toBeVisible();
  await page.getByRole("button", { name: "Close shift and print Z-report" }).click();
  await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
  await expect.poll(() => printCount()).toBeGreaterThan(printsBefore);
  await page.getByRole("button", { name: "Done" }).click();

  // Selling is blocked again until a new shift opens.
  await expect(openDialog(page)).toBeVisible();

  // The server holds the Z: immutable, numbered, with the right over/short.
  await waitFor(
    async () =>
      (await sql`select count(*)::int as n from shift_closes where org_id = ${orgId}`)[0]!.n,
    1,
  );
  const [z] = await sql`
    select z_seq, counted_cents, expected_cents, over_short_cents, review_flags from shift_closes
    where org_id = ${orgId}`;
  expect(z).toMatchObject({
    z_seq: 1,
    counted_cents: 12300,
    expected_cents: 12500,
    over_short_cents: -200,
    review_flags: [],
  });
  expect(
    (await sql`select count(*)::int as n from shift_documents where org_id = ${orgId}`)[0]!.n,
  ).toBe(1);
  expect(
    (await sql`select count(*)::int as n from cash_movements where org_id = ${orgId}`)[0]!.n,
  ).toBe(2);
});

test("a shift closed offline reaches the server once, after its sale", async ({ page }) => {
  const { orgId } = await setup(page, "offline");
  await openDialog(page)
    .getByLabel(/Float in the drawer/)
    .fill("50");
  await openDialog(page).getByRole("button", { name: "Open shift" }).click();
  await expect(openDialog(page)).toBeHidden();

  await page.context().setOffline(true);
  await page.getByRole("button", { name: /^Tea bags/ }).click();
  await page.getByRole("button", { name: "Pay €10.00" }).first().click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /^Exact/ }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  await page.getByRole("button", { name: "Shift" }).click();
  await page.getByRole("button", { name: "Close shift" }).click();
  await page.getByLabel("Cash counted (€)").fill("60");
  await expect(page.getByText("Balanced")).toBeVisible();
  await page.getByRole("button", { name: "Close shift and print Z-report" }).click();
  await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
  expect(
    (await sql`select count(*)::int as n from shift_closes where org_id = ${orgId}`)[0]!.n,
  ).toBe(0);

  await page.context().setOffline(false);
  await waitFor(
    async () =>
      (await sql`select count(*)::int as n from shift_closes where org_id = ${orgId}`)[0]!.n,
    1,
  );
  const [z] =
    await sql`select over_short_cents, review_flags from shift_closes where org_id = ${orgId}`;
  expect(z).toMatchObject({ over_short_cents: 0, review_flags: [] });
  expect((await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n).toBe(1);
});
