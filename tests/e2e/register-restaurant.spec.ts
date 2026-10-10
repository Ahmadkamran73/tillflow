import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import {
  hydrated,
  openDashboard,
  openTill,
  signUpAndEnrol,
  TILL_NAME,
  TILL_PIN,
  uniqueEmail,
} from "./helpers";

// Needs the local Supabase stack and .env.local (DIRECT_URL looks at the server's tables as an
// administrator). A table of four: two courses, split by seat, one seat pays by card with a tip and
// the other pays cash. 10% service charge, taxed at the rate of what it is charged on.

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(180_000);

async function product(
  page: Page,
  orgId: string,
  p: { name: string; price: string; category: string; vat: "CATERING" | "STANDARD" },
) {
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill(p.name);
  await page.getByLabel("Category").selectOption({ label: p.category });
  await page.getByLabel("VAT rate", { exact: true }).selectOption(p.vat);
  await page.getByLabel("Price (including VAT)").fill(p.price);
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
}

test("table of four: two courses, split by seat, one pays card with a tip, one pays cash", async ({
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
  await signUpAndEnrol(page, uniqueEmail("resto"), "E2E restaurant");
  const orgId = await openDashboard(page, { type: "Restaurant (table service)" });

  await product(page, orgId, {
    name: "Soup",
    price: "6.00",
    category: "Starters",
    vat: "CATERING",
  });
  await product(page, orgId, { name: "Steak", price: "20.00", category: "Mains", vat: "CATERING" });
  await product(page, orgId, { name: "Wine", price: "8.00", category: "Bar", vat: "STANDARD" });

  // Service charge 10% (owner), floor plan with one table of four (manager/owner).
  await page.goto(`/o/${orgId}/settings/service-charge`);
  await hydrated(page);
  await page.getByLabel(/^Service charge/).fill("10");
  await page.getByRole("button", { name: "Save service charge" }).click();
  await expect(page.getByRole("status")).toHaveText("Service charge saved.");

  await page.goto(`/o/${orgId}/settings/floor-plan`);
  await page.waitForLoadState("networkidle"); // the editor has no form to wait on
  await page.getByRole("button", { name: "Add table" }).click();
  await page.getByLabel("Table name").fill("T1");
  // Move it with the keyboard (no drag needed), then save.
  await page.getByRole("button", { name: /^Table T1/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("status")).toContainText("Table T1 moved to column 2, row 1");
  await page.getByRole("button", { name: "Save floor plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Floor plan saved.");
  const [counted] = await sql`
    select count(*)::int as n from restaurant_tables where org_id = ${orgId} and archived_at is null`;
  expect(counted!.n).toBe(1);

  await openTill(page, orgId);

  // One kitchen printer in browser mode, so tickets can be read back; every category defaults to it.
  await page.getByRole("button", { name: /^Tickets/ }).click();
  await page.getByRole("button", { name: "Set up Kitchen printer" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("button", { name: "Close" }).click();

  // The table map: T1 is free. Open it for four guests.
  await expect(page.getByRole("heading", { name: "Tables" })).toBeVisible();
  await expect(page.getByText("Tabs are not shared between tills.")).toBeVisible();
  const t1 = () => page.getByRole("button", { name: /^Table T1/ });
  await expect(t1()).toContainText("Free");
  await t1().click();
  await page.getByLabel("How many guests?").fill("4");
  await page.getByRole("button", { name: "Open table", exact: true }).click();
  await expect(page.locator("p.font-semibold", { hasText: "Table T1 · 4 guests" })).toBeVisible();

  // Seat 1: soup (course 1) and steak (course 2). Seat 2: soup (course 1) and wine (course 2).
  const add = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
  const course = (n: number) =>
    page.getByRole("group", { name: "Course" }).getByRole("button", { name: `Course ${n}` });
  await add("Soup");
  await course(2).click();
  await add("Steak");
  await page.getByRole("button", { name: "Next seat" }).click();
  await add("Wine");
  await course(1).click();
  await add("Soup");

  // Send releases course 1 only; the steak and the wine are held.
  await expect(page.getByText(/Seat 1 · Course 2 · Held/)).toBeVisible();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByText("Sent 2 items for course 1.")).toBeVisible();
  let prints = await page.evaluate(() => (window as unknown as { __prints: string[] }).__prints);
  const first = prints.at(-1)!;
  expect(first).toContain("Table T1");
  expect(first).toContain("COURSE 1");
  expect(first).toContain("1 x Soup (seat 1)");
  expect(first).toContain("1 x Soup (seat 2)");
  expect(first).not.toContain("Steak");
  expect(first).not.toContain("€"); // a ticket never shows amounts

  // A sent line has no Remove, only Void (which needs a manager).
  await expect(page.getByRole("button", { name: "Remove Soup" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Void Soup" })).toHaveCount(2);

  // Fire the next course: the mains go to the kitchen with FIRE.
  await page.getByRole("button", { name: "Fire next course" }).click();
  await expect(page.getByText("Sent 2 items for course 2.")).toBeVisible();
  prints = await page.evaluate(() => (window as unknown as { __prints: string[] }).__prints);
  const second = prints.at(-1)!;
  expect(second).toContain("COURSE 2");
  expect(second).toContain("FIRE");
  expect(second).toContain("1 x Steak (seat 1)");
  expect(second).toContain("1 x Wine (seat 2)");
  expect(second).not.toContain("Soup");

  // Voiding a sent line needs a manager PIN, prints a cancellation ticket and is audit-logged.
  await page.getByRole("button", { name: "Void Wine" }).click();
  await expect(page.getByRole("heading", { name: "Manager approval needed" })).toBeVisible();
  await page.getByRole("button", { name: new RegExp(`^${TILL_NAME}`) }).click();
  await page.getByLabel(`PIN for ${TILL_NAME}`).fill(TILL_PIN);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Wine voided/)).toBeVisible();
  prints = await page.evaluate(() => (window as unknown as { __prints: string[] }).__prints);
  const cancel = prints.at(-1)!;
  expect(cancel).toContain("*** CANCEL ***");
  expect(cancel).toContain("1 x Wine (seat 2)");
  // The wine is rung up again (course 2, seat 2) and goes out with the bill if still unsent.
  await course(2).click();
  await add("Wine");

  // 40.00 of food plus 10% service = 44.00.
  await expect(page.getByText("Service charge 10%")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pay €44.00" }).first()).toBeVisible();

  // Bill, split by seat: two bills.
  await page.getByRole("button", { name: "Bill", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Split the bill" })).toBeVisible();
  await expect(page.getByText("2 seats on this bill.")).toBeVisible();
  await page.getByRole("button", { name: "Split into 2 bills" }).click();
  await expect(page.locator("p.font-semibold", { hasText: "Table T1 · bill 1" })).toBeVisible();

  // Bill 1 (seat 1: soup + steak = 26.00 + 2.60 service): card with a 3.00 tip.
  await page.getByRole("button", { name: "Pay €28.60" }).first().click();
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByLabel(/^Tip/).fill("3.00");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();

  // The table now shows the bill; the second bill is what is left.
  await expect(page.getByRole("heading", { name: "Tables" })).toBeVisible();
  await expect(t1()).toContainText("Bill");
  await t1().click();
  await expect(page.locator("p.font-semibold", { hasText: "Table T1 · bill 2" })).toBeVisible();

  // Bill 2 (seat 2: soup + wine = 14.00 + 1.40 service): cash, exact.
  await page.getByRole("button", { name: "Pay €15.40" }).first().click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await page.getByRole("button", { name: /^Exact/ }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  await expect(t1()).toContainText("Free");

  // Server: two sales on one tab, the service charge as taxed lines, the tip, and the tab events.
  await expect
    .poll(
      async () => (await sql`select count(*)::int as n from sales where org_id = ${orgId}`)[0]!.n,
      { timeout: 60_000 },
    )
    .toBe(2);
  const sales = await sql`
    select s.id, s.amount_due_cents, s.vat_cents, s.review_flags from sales s
    where s.org_id = ${orgId} order by s.amount_due_cents desc`;
  expect(sales.map((s) => s.amount_due_cents)).toEqual([2860, 1540]);
  expect(sales.every((s) => s.review_flags.length === 0)).toBe(true);

  const service = await sql`
    select l.tax_rate_bp, l.gross_cents, l.net_cents, l.vat_cents, l.variant_id, s.amount_due_cents
    from sale_lines l join sales s on s.id = l.sale_id
    where l.org_id = ${orgId} and l.name = 'Service charge 10%'
    order by s.amount_due_cents desc, l.tax_rate_bp, l.gross_cents`;
  // One charge line per item, at that item's rate: bill 1 soup 60 and steak 200 (both 9%); bill 2
  // soup 60 (9%) and wine 80 (23%).
  expect(service.map((l) => [l.amount_due_cents, l.tax_rate_bp, l.gross_cents])).toEqual([
    [2860, 900, 60],
    [2860, 900, 200],
    [1540, 900, 60],
    [1540, 2300, 80],
  ]);
  for (const l of service) {
    expect(l.variant_id).toBeNull();
    expect(Number(l.net_cents) + Number(l.vat_cents)).toBe(Number(l.gross_cents));
  }
  const [tip] =
    await sql`select tip_cents from payments where org_id = ${orgId} and method = 'card'`;
  expect(tip!.tip_cents).toBe(300);
  const [cash] =
    await sql`select amount_cents from payments where org_id = ${orgId} and method = 'cash'`;
  expect(cash!.amount_cents).toBe(1540);

  const [voided] = await sql`
    select after from audit_log where org_id = ${orgId} and action = 'tab.void_item'`;
  expect(voided!.after).toMatchObject({
    approval: "pin_verified",
    detail: { item: "Wine", qty: 1 },
  });

  const links = await sql`select distinct tab_id from sale_tabs where org_id = ${orgId}`;
  expect(links).toHaveLength(1);
  await expect
    .poll(
      async () =>
        (
          await sql`select kind from tab_events where org_id = ${orgId} order by at, created_at`
        ).map((e) => e.kind as string),
      { timeout: 60_000 },
    )
    .toEqual(["open", "send", "fire", "close"]);
  expect(links[0]!.tab_id).toBe(
    (await sql`select tab_id from tab_events where org_id = ${orgId} and kind = 'open'`)[0]!.tab_id,
  );
  const [open] = await sql`select detail from tab_events where org_id = ${orgId} and kind = 'open'`;
  expect(open!.detail).toEqual({ table: "T1", covers: 4 });
});

test("a partial refund returns the service charge pro rata, at the item's rate", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await signUpAndEnrol(page, uniqueEmail("restorefund"), "E2E restaurant refund");
  const orgId = await openDashboard(page, { type: "Restaurant (table service)" });
  await product(page, orgId, { name: "Steak", price: "20.00", category: "Mains", vat: "CATERING" });

  await page.goto(`/o/${orgId}/settings/service-charge`);
  await hydrated(page);
  await page.getByLabel(/^Service charge/).fill("10");
  await page.getByRole("button", { name: "Save service charge" }).click();
  await expect(page.getByRole("status")).toHaveText("Service charge saved.");
  await page.goto(`/o/${orgId}/settings/floor-plan`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add table" }).click();
  await page.getByLabel("Table name").fill("T1");
  await page.getByRole("button", { name: "Save floor plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Floor plan saved.");
  await openTill(page, orgId);

  // Two steaks at table T1: 40.00 + 10% service = 44.00, paid by card.
  await page.getByRole("button", { name: /^Table T1/ }).click();
  await page.getByLabel("How many guests?").fill("2");
  await page.getByRole("button", { name: "Open table", exact: true }).click();
  await page.getByRole("button", { name: /^Steak/ }).click();
  await page.getByRole("button", { name: /^Steak/ }).click();
  await page.getByRole("button", { name: "Pay €44.00" }).first().click();
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  await expect
    .poll(async () => (await sql`select 1 from sales where org_id = ${orgId}`).length, {
      timeout: 60_000,
    })
    .toBe(1);
  // The charge is stored beside its item, with the item's quantity.
  const stored = await sql`
    select name, qty, gross_cents, tax_rate_bp from sale_lines
    where org_id = ${orgId} order by line_no`;
  expect(stored.map((l) => [l.name, l.qty, l.gross_cents, l.tax_rate_bp])).toEqual([
    ["Steak", 2, 4000, 900],
    ["Service charge 10%", 2, 400, 900],
  ]);

  // Return one steak, twice: each time the item and half the charge go back together.
  for (const n of [1, 2]) {
    await page.getByRole("button", { name: "Refund", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /Till 1 · \d{6}/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Return one more Steak" }).click();
    await page.getByRole("dialog").getByLabel("Reason").selectOption("faulty");
    await expect(page.getByRole("dialog").getByText("To give back: €22.00")).toBeVisible();
    await page.getByRole("button", { name: "Next: pay back" }).click();
    await expect(page.getByRole("dialog").getByLabel("Card amount")).toHaveValue("22.00");
    await page.getByRole("button", { name: "Complete refund" }).click();
    await page.getByRole("button", { name: "Back to the till" }).click();
    await expect
      .poll(async () => (await sql`select 1 from refunds where org_id = ${orgId}`).length, {
        timeout: 60_000,
      })
      .toBe(n);
  }
  const lines = await sql`
    select sl.name, rl.qty, rl.gross_cents, rl.vat_cents, rl.tax_rate_bp
    from refund_lines rl join sale_lines sl on sl.id = rl.sale_line_id
    where rl.org_id = ${orgId} order by sl.line_no, rl.created_at`;
  expect(lines.map((l) => [l.name, l.qty, l.gross_cents, l.tax_rate_bp])).toEqual([
    ["Steak", 1, 2000, 900],
    ["Steak", 1, 2000, 900],
    ["Service charge 10%", 1, 200, 900],
    ["Service charge 10%", 1, 200, 900],
  ]);
  // Everything came back, to the cent: item, charge and VAT.
  const [sum] = await sql`
    select sum(gross_cents)::int as gross, sum(vat_cents)::int as vat from refund_lines
    where org_id = ${orgId}`;
  const [sale] = await sql`select amount_due_cents, vat_cents from sales where org_id = ${orgId}`;
  expect(sum!.gross).toBe(sale!.amount_due_cents);
  expect(sum!.vat).toBe(sale!.vat_cents);
});
