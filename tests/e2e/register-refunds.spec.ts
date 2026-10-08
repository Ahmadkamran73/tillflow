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

// Needs the local Supabase stack and its .env.local values (DIRECT_URL is how the test looks at the
// server's tables, as an administrator). The card is taken on the shop's own terminal, so a card
// refund here is just the cashier tapping to say they did it.

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(240_000);

const TEA = "12.34";
const dialog = (page: Page) => page.getByRole("dialog");
const choose = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).click();

async function addProduct(
  page: Page,
  orgId: string,
  name: string,
  price: string,
  barcode?: string,
) {
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Price (including VAT)").fill(price);
  if (barcode) await page.getByLabel("Barcode").fill(barcode);
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
}

async function setup(page: Page, label: string, businessType?: string) {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await signUpAndEnrol(page, uniqueEmail(label), `E2E refunds ${label}`);
  const orgId = await openDashboard(page);
  await addProduct(page, orgId, "Tea bags", TEA, "5012345678900");
  await addProduct(page, orgId, "Biscuits", "5.00", "5012345678917");
  // Clothing shops have the exchange flow; the preset is read when the till loads.
  if (businessType)
    await sql`update organisations set business_type = ${businessType} where id = ${orgId}`;
  await openTill(page, orgId);
  return orgId;
}

const tile = (page: Page, name = "Tea bags") =>
  page.getByRole("button", { name: new RegExp(`^${name}`) });

/** Rings up `qty` Tea bags and takes it on the card terminal. */
async function sellTea(page: Page, qty: number) {
  for (let i = 0; i < qty; i++) await tile(page).click();
  const total = (12.34 * qty).toFixed(2);
  await page
    .getByRole("button", { name: `Pay €${total}` })
    .first()
    .click();
  await choose(page, "Card");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
}

const waitFor = (orgId: string, table: "sales" | "refunds", n: number) =>
  expect
    .poll(
      async () =>
        (await sql`select count(*)::int as n from ${sql(table)} where org_id = ${orgId}`)[0]!.n,
      { timeout: 60_000 },
    )
    .toBe(n);

async function openRefund(page: Page) {
  await page.getByRole("button", { name: "Refund", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "Find the sale" })).toBeVisible();
}

/** Picks the newest sale in the list. */
const pickRecent = (page: Page) =>
  dialog(page)
    .getByRole("button", { name: /Till 1 · \d{6}/ })
    .first()
    .click();

test("a partial refund of a card sale: the original rate, the card back, the sale untouched", async ({
  page,
}) => {
  const orgId = await setup(page, "partial");
  await sellTea(page, 2);
  await waitFor(orgId, "sales", 1);

  await openRefund(page);
  await pickRecent(page);
  await expect(
    dialog(page).getByRole("heading", { name: "What is being returned?" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return one more Tea bags" }).click();
  await dialog(page).getByLabel("Reason").selectOption("faulty");
  await expect(dialog(page).getByText(`To give back: €${TEA}`)).toBeVisible();
  await page.getByRole("button", { name: "Next: pay back" }).click();

  // Card first: the card took the whole sale, so the refund goes back to it, exact.
  await expect(dialog(page).getByLabel("Card amount")).toHaveValue(TEA);
  await expect(dialog(page).getByText("All of it is allocated.")).toBeVisible();
  await dialog(page).getByLabel("Reference (optional)").first().fill("RFD 001");
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(dialog(page).getByText(`Give back €${TEA}`)).toBeVisible();
  await page.getByRole("button", { name: "Back to the till" }).click();

  await waitFor(orgId, "refunds", 1);
  const [sale] =
    await sql`select id, vat_cents, amount_due_cents from sales where org_id = ${orgId}`;
  const [refund] = await sql`select * from refunds where org_id = ${orgId}`;
  const [line] = await sql`select * from refund_lines where refund_id = ${refund!.id}`;
  const [pay] = await sql`select * from refund_payments where refund_id = ${refund!.id}`;
  expect(refund).toMatchObject({ kind: "refund", reason_code: "faulty", amount_cents: 1234 });
  // the VAT given back is the original line's share at 23%
  expect(line).toMatchObject({ qty: 1, tax_rate_bp: 2300, gross_cents: 1234 });
  expect(line!.vat_cents + line!.net_cents).toBe(1234);
  expect(refund!.vat_cents).toBe(Math.round(sale!.vat_cents / 2));
  expect(pay).toMatchObject({ method: "card", amount_cents: 1234, provider_ref: "RFD 001" });
  // the sale is exactly as it was, and the unit went back into stock
  expect(sale!.amount_due_cents).toBe(2468);
  const [stock] = await sql`select coalesce(sum(qty_delta), 0)::int as n from stock_movements
    where org_id = ${orgId} and reason = 'refund'`;
  expect(stock!.n).toBe(1);

  // The second unit: the dialog shows the first one is used up.
  await openRefund(page);
  await pickRecent(page);
  await expect(dialog(page).getByText("1 left")).toBeVisible();
});

test("a void reverses the whole sale on the same day", async ({ page }) => {
  const orgId = await setup(page, "void");
  await sellTea(page, 1);
  await waitFor(orgId, "sales", 1);

  await openRefund(page);
  await pickRecent(page);
  await page.getByRole("button", { name: "Void the whole sale" }).click();
  await expect(dialog(page).getByText("Voiding the whole sale")).toBeVisible();
  await expect(dialog(page).getByLabel("Reason")).toHaveValue("void_mistake");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await page.getByRole("button", { name: "Complete void" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Sale voided" })).toBeVisible();
  await page.getByRole("button", { name: "Back to the till" }).click();

  await waitFor(orgId, "refunds", 1);
  const [refund] =
    await sql`select kind, items_total_cents, vat_cents from refunds where org_id = ${orgId}`;
  expect(refund).toMatchObject({ kind: "void", items_total_cents: 1234 });
  const [audit] =
    await sql`select action from audit_log where org_id = ${orgId} and action = 'sale.voided'`;
  expect(audit).toBeTruthy();
});

test("a cashier's refund above the limit needs a manager's PIN; below it does not", async ({
  page,
}) => {
  const orgId = await setup(page, "approval");
  // The owner sets the limit to €5.00.
  await page.goto(`/o/${orgId}/settings/refund-limit`);
  await hydrated(page);
  await page.getByLabel(/^Limit \(euro\)/).fill("5.00");
  await page.getByRole("button", { name: "Save limit" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect(
    (await sql`select refund_override_cents from organisations where id = ${orgId}`)[0]!
      .refund_override_cents,
  ).toBe(500);

  // A cashier, Aoife.
  await page.goto(`/o/${orgId}/staff`);
  await page.getByRole("link", { name: "Add cashier" }).click();
  await hydrated(page);
  await page.getByLabel("Name shown on the till").fill("Aoife");
  await page.getByLabel("PIN (4 to 6 digits)").fill("4826");
  await page.getByLabel("Repeat the PIN").fill("4826");
  await page.getByRole("button", { name: "Add cashier" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Cashier added" })).toBeVisible();

  await page.goto(`/register/${orgId}`);
  await expect(page.getByRole("button", { name: /^Aoife/ })).toBeVisible({ timeout: 30_000 });
  await unlockTill(page, "Aoife", "4826");
  await sellTea(page, 1);
  await tile(page, "Biscuits").click();
  await page.getByRole("button", { name: "Pay €5.00" }).first().click();
  await choose(page, "Card");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await page.getByRole("button", { name: "New sale" }).click();
  await waitFor(orgId, "sales", 2);

  // Refunding the €5.00 biscuits (at the limit, not above it) needs no PIN.
  await openRefund(page);
  await dialog(page)
    .getByRole("button", { name: /Till 1 · 000002/ })
    .click();
  await page.getByRole("button", { name: "Return one more Biscuits" }).click();
  await dialog(page).getByLabel("Reason").selectOption("changed_mind");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Refund saved" })).toBeVisible();
  await page.getByRole("button", { name: "Back to the till" }).click();

  // The €12.34 tea is above it: a manager must enter their PIN.
  await openRefund(page);
  await dialog(page)
    .getByRole("button", { name: /Till 1 · 000001/ })
    .click();
  await page.getByRole("button", { name: "Return one more Tea bags" }).click();
  await dialog(page).getByLabel("Reason").selectOption("wrong_item");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(
    dialog(page).getByRole("heading", { name: "Manager approval needed" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^Maeve/ }).click();
  await page.getByLabel("PIN for Maeve").fill("2580");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Refund saved" })).toBeVisible();

  await waitFor(orgId, "refunds", 2);
  const rows = await sql`select amount_cents, approval_id, approved_by from refunds
    where org_id = ${orgId} order by amount_cents`;
  expect(rows[0]).toMatchObject({ amount_cents: 500, approval_id: null, approved_by: null });
  expect(rows[1]).toMatchObject({ amount_cents: 1234 });
  expect(rows[1]!.approval_id).not.toBeNull();
  expect(rows[1]!.approved_by).not.toBeNull();
});

test("a refund of a sale made on this till works with no connection, and syncs exactly once", async ({
  page,
  context,
}) => {
  const orgId = await setup(page, "offline");
  await sellTea(page, 1);
  await waitFor(orgId, "sales", 1);

  await context.setOffline(true);
  await openRefund(page);
  await pickRecent(page);
  await page.getByRole("button", { name: "Return one more Tea bags" }).click();
  await dialog(page).getByLabel("Reason").selectOption("damaged");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Refund saved" })).toBeVisible();
  await page.getByRole("button", { name: "Back to the till" }).click();
  expect((await sql`select count(*)::int as n from refunds where org_id = ${orgId}`)[0]!.n).toBe(0);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitFor(orgId, "refunds", 1);
  await page.waitForTimeout(3_000);
  expect((await sql`select count(*)::int as n from refunds where org_id = ${orgId}`)[0]!.n).toBe(1);
});

test("a clothing exchange for something dearer: the credit pays part, the rest is paid on top", async ({
  page,
}) => {
  const orgId = await setup(page, "exchange-dearer", "clothing");
  await sellTea(page, 1);
  await waitFor(orgId, "sales", 1);

  // The new item (€5.00 + €12.34 of tea) is in the cart; the returned tea becomes credit.
  await tile(page, "Biscuits").click();
  await tile(page).click();
  await openRefund(page);
  await pickRecent(page);
  await page.getByRole("button", { name: "Return one more Tea bags" }).click();
  await page.getByRole("button", { name: "Exchange for other items" }).click();
  await dialog(page).getByLabel("Reason").selectOption("wrong_item");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await expect(dialog(page).getByText(`Exchange credit: €${TEA}`)).toBeVisible();
  await page.getByRole("button", { name: "Complete exchange" }).click();

  // The payment screen opens with the credit already taken; €5.00 is left.
  await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
  await expect(dialog(page).getByText(`Exchange credit €${TEA}`)).toBeVisible();
  await choose(page, "Card");
  await expect(page.getByLabel("Card amount")).toHaveValue("5.00");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();

  await waitFor(orgId, "sales", 2);
  await waitFor(orgId, "refunds", 1);
  const [refund] =
    await sql`select kind, credit_cents, amount_cents, exchange_sale_id from refunds where org_id = ${orgId}`;
  expect(refund).toMatchObject({ kind: "exchange", credit_cents: 1234, amount_cents: 0 });
  const pays = await sql`select method, amount_cents, exchange_refund_id from payments
    where sale_id = ${refund!.exchange_sale_id} order by method`;
  expect(pays.map((p) => [p.method, p.amount_cents])).toEqual([
    ["card", 500],
    ["exchange", 1234],
  ]);
});

test("a clothing exchange for something cheaper: the credit covers it and the rest goes back", async ({
  page,
}) => {
  const orgId = await setup(page, "exchange-cheaper", "clothing");
  await sellTea(page, 1);
  await waitFor(orgId, "sales", 1);

  await tile(page, "Biscuits").click(); // €5.00 in the cart
  await openRefund(page);
  await pickRecent(page);
  await page.getByRole("button", { name: "Return one more Tea bags" }).click();
  await page.getByRole("button", { name: "Exchange for other items" }).click();
  await dialog(page).getByLabel("Reason").selectOption("wrong_item");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  // €12.34 comes back, €5.00 is used as credit, €7.34 goes back to the card it was paid on.
  await expect(dialog(page).getByText("Exchange credit: €5.00")).toBeVisible();
  await expect(dialog(page).getByLabel("Card amount")).toHaveValue("7.34");
  await page.getByRole("button", { name: "Complete exchange" }).click();

  await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();

  await waitFor(orgId, "sales", 2);
  await waitFor(orgId, "refunds", 1);
  const [refund] =
    await sql`select id, credit_cents, amount_cents from refunds where org_id = ${orgId}`;
  expect(refund).toMatchObject({ credit_cents: 500, amount_cents: 734 });
  const legs =
    await sql`select method, amount_cents from refund_payments where refund_id = ${refund!.id} order by method`;
  expect(legs.map((l) => [l.method, l.amount_cents])).toEqual([
    ["card", 734],
    ["exchange", 500],
  ]);
});

test("cancelling an exchange leaves nothing behind (the refund is only saved with its sale)", async ({
  page,
}) => {
  const orgId = await setup(page, "exchange-cancel", "clothing");
  await sellTea(page, 1);
  await waitFor(orgId, "sales", 1);

  await tile(page, "Biscuits").click();
  await openRefund(page);
  await pickRecent(page);
  await page.getByRole("button", { name: "Return one more Tea bags" }).click();
  await page.getByRole("button", { name: "Exchange for other items" }).click();
  await dialog(page).getByLabel("Reason").selectOption("wrong_item");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await page.getByRole("button", { name: "Complete exchange" }).click();
  await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();

  // The customer changes their mind at the payment screen.
  await dialog(page).getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText(/Nothing is recorded until the sale is complete/).first()).toBeVisible();
  await page.getByRole("button", { name: "Cancel exchange" }).click();
  await expect(page.getByText(/Exchange cancelled/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel exchange" })).toHaveCount(0);

  // Nothing was recorded, now or later, and the original sale can still be refunded in full.
  await page.waitForTimeout(3_000);
  expect((await sql`select count(*)::int as n from refunds where org_id = ${orgId}`)[0]!.n).toBe(0);
  await openRefund(page);
  await pickRecent(page);
  await expect(dialog(page).getByText("1 left")).toBeVisible();
});

test("a refund the till could only name a manager for is recorded and lands in Needs attention", async ({
  page,
}) => {
  const orgId = await setup(page, "unverified");
  await sellTea(page, 1);
  await waitFor(orgId, "sales", 1);
  // Tills are paired by the owner; make the refund limit €5 so €12.34 needs a manager, and work with
  // no connection so the manager's PIN can only be checked against the copy on the till.
  await sql`update organisations set refund_override_cents = 500 where id = ${orgId}`;
  await page.goto(`/register/${orgId}`);
  await unlockTill(page);
  // the owner serving needs no PIN: the refund is recorded as "self" and flagged
  await openRefund(page);
  await pickRecent(page);
  await page.getByRole("button", { name: "Return one more Tea bags" }).click();
  await dialog(page).getByLabel("Reason").selectOption("damaged");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Refund saved" })).toBeVisible();

  await waitFor(orgId, "refunds", 1);
  const [refund] = await sql`select id, approval_state from refunds where org_id = ${orgId}`;
  expect(refund!.approval_state).toBe("self");
  const [item] = await sql`select reason, status from sync_rejections where org_id = ${orgId}`;
  expect(item).toMatchObject({ reason: "refund_unverified", status: "open" });

  // The owner sees it under Needs attention, with no "Try again", and closes it with a note.
  await page.goto(`/o/${orgId}/sales/attention`);
  await expect(page.getByText(/This refund WAS recorded/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await page.getByLabel(/Note/).first().fill("Checked with the cashier");
  await page.getByRole("button", { name: "Mark resolved" }).click();
  await expect(page).toHaveURL(/result=resolved/);
  await expect
    .poll(
      async () =>
        (await sql`select status from sync_rejections where id = ${refund!.id}`)[0]!.status,
    )
    .toBe("resolved");
});
