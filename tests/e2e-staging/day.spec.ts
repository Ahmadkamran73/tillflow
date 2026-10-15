import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import { hydrated, makePairingCode, setMyPin, unlockTill } from "../e2e/helpers";
import { euro, exact, expected, type Refund, type Sale } from "../e2e/day/ledger";
import {
  FLOAT,
  addProduct,
  checkExports,
  dialog,
  expectRow,
  openRefund,
  openReport,
  payCard,
  payCash,
  pickRecent,
  readTable,
  returnToCard,
  row,
  tile,
} from "../e2e/day/ui";

// One whole trading day on the STAGING app, as a person would do it, for the business types that
// have a staging account in .env.local (STAGING_E2E_EMAIL / _PASSWORD for the general store, and
// STAGING_E2E_<TYPE>_EMAIL / _PASSWORD for the others). No database access: every figure is read
// from the screens and compared with the independent calculator (tests/e2e/day/ledger.ts).
// Run once per shop per day; a second run on the same day is compared with a baseline instead.

config({ path: ".env.local", quiet: true });
test.setTimeout(1_200_000);

const creds = (type: string) => {
  const key = type === "general" ? "STAGING_E2E" : `STAGING_E2E_${type.toUpperCase()}`;
  return { email: process.env[`${key}_EMAIL`], password: process.env[`${key}_PASSWORD`] };
};

async function signIn(page: Page, email: string, password: string) {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await page.goto("/login");
  await hydrated(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page
    .getByRole("button", { name: /log in|sign in/i })
    .first()
    .click();
  await expect(page).toHaveURL(/\/o\/[0-9a-f-]{36}\/dashboard$/, { timeout: 30_000 });
  return /\/o\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
}

const dublinDay = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(new Date());

/** Pairs this browser as Till 1 (no rate-limit reset: staging has no database access here). */
async function openTillOnStaging(page: Page, orgId: string) {
  await setMyPin(page, orgId);
  const code = await makePairingCode(page, orgId);
  await page.goto("/register/pair");
  await hydrated(page);
  await page.getByLabel("Pairing code").fill(code);
  await page.getByRole("button", { name: "Pair this till" }).click();
  await expect(page).toHaveURL(new RegExp(`/register/${orgId}$`));
  await unlockTill(page);
}

async function closeShiftOnScreen(page: Page, orgId: string, counted: number) {
  await page.getByRole("button", { name: "Shift" }).click();
  await page.getByRole("button", { name: "Close shift" }).click();
  await page.getByLabel("Cash counted (€)").fill((counted / 100).toFixed(2));
  await page.getByRole("button", { name: "Close shift and print Z-report" }).click();
  await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  // The newest shift in the back office is the one just closed.
  await page.goto(`/o/${orgId}/shifts`);
  const href = await page
    .locator("main a")
    .evaluateAll((as) =>
      as.map((a) => a.getAttribute("href")).find((h) => /\/shifts\/[0-9a-f-]{36}$/.test(h ?? "")),
    );
  expect(href, "a shift link in the Shifts list").toBeTruthy();
  await page.goto(href!);
  return page.locator("main");
}

/** Reads the sales-by-day row for `day`, or null (an empty day shows no table). */
async function dayRow(page: Page, orgId: string, day: string) {
  await page.goto(`/o/${orgId}/reports/sales-by-day?from=${day}&to=${day}`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  const shown = await page
    .getByTestId("report-table")
    .waitFor({ timeout: 4000 })
    .then(
      () => true,
      () => false,
    );
  if (!shown) return { t: null, r: null };
  const t = await readTable(page);
  const label = day.split("-").reverse().join("/");
  return { t, r: t.rows.find((x) => x[0] === label) ?? null };
}

// ---------------------------------------------------------------- the general store's day

test("staging · general store: open shift, sales, refund, Z-report, reports and exports", async ({
  page,
}) => {
  const { email, password } = creds("general");
  test.skip(!email || !password, "no STAGING_E2E_EMAIL / STAGING_E2E_PASSWORD in .env.local");
  const orgId = await signIn(page, email!, password!);
  const day = dublinDay();
  const label = day.split("-").reverse().join("/");

  const before = await dayRow(page, orgId, day);
  const baseline = before.r !== null;

  // Names and barcodes carry a tag so a second run does not clash with the first.
  const tag = Date.now().toString(36).slice(-4).toUpperCase();
  const code = (n: number) => `50${Date.now().toString().slice(-9)}${n}`;
  const N = {
    tea: `Tea bags ${tag}`,
    milk: `Milk ${tag}`,
    candle: `Candle ${tag}`,
    cola: `Cola can ${tag}`,
  };
  await addProduct(page, orgId, { name: N.tea, price: "12.34", barcode: code(1), stock: "20" });
  await addProduct(page, orgId, {
    name: N.milk,
    price: "1.50",
    vat: "ZERO",
    barcode: code(2),
    stock: "50",
  });
  await addProduct(page, orgId, {
    name: N.candle,
    price: "10.00",
    vat: "REDUCED",
    barcode: code(3),
    stock: "10",
  });
  await addProduct(page, orgId, {
    name: N.cola,
    price: "2.00",
    deposit: "0.15",
    barcode: code(4),
    stock: "30",
  });
  await openTillOnStaging(page, orgId);

  // S1: cash, a 10% line discount on the milk, a can with its deposit; 15.84 rounds to 15.85.
  await tile(page, N.tea).click();
  await tile(page, N.milk).click();
  await tile(page, N.cola).click();
  await page.getByRole("button", { name: `Discount on ${N.milk}` }).click();
  await page.getByRole("textbox", { name: "Percent (%)" }).fill("10");
  await page.getByRole("button", { name: "Apply discount" }).click();
  await payCash(page, 1584, 2000, 1585);
  // S2: two candles at 13.5% on the card.
  await tile(page, N.candle).click();
  await tile(page, N.candle).click();
  await payCard(page, 2000);
  // S3: two tea bags, 10.00 on the card and the rest in cash, rounded on the cash share only.
  await tile(page, N.tea).click();
  await tile(page, N.tea).click();
  await page.getByRole("button", { name: "Pay €24.68" }).first().click();
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await page.getByLabel("Card amount").fill("10");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Cash", exact: true }).click();
  await expect(page.getByText("Cash due: €14.70")).toBeVisible();
  await page.getByRole("button", { name: "€20.00", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  // Refund one candle (of S2, the second newest sale) to the card.
  await openRefund(page);
  await pickRecent(page, 1);
  await returnToCard(page, N.candle);
  await expect(dialog(page)).toBeHidden();

  const sales: Sale[] = [
    {
      key: "s1",
      lines: [
        { name: "Tea bags", gross: 1234, rateBp: 2300 },
        { name: "Milk", gross: 135, rateBp: 0, discount: 15 },
        { name: "Cola can", gross: 200, rateBp: 2300 },
      ],
      deposit: 15,
      pays: [{ method: "cash", amount: 1585 }],
    },
    {
      key: "s2",
      lines: [{ name: "Candle", gross: 2000, rateBp: 1350, qty: 2 }],
      pays: [{ method: "card", amount: 2000 }],
    },
    {
      key: "s3",
      lines: [{ name: "Tea bags", gross: 2468, rateBp: 2300, qty: 2 }],
      pays: [
        { method: "card", amount: 1000 },
        { method: "cash", amount: 1470 },
      ],
    },
  ];
  const refunds: Refund[] = [
    {
      sale: "s2",
      lines: [{ sale: "s2", line: 0, units: 1, of: 2 }],
      legs: [{ method: "card", amount: 1000 }],
    },
  ];
  const counted = 13050; // expected 13,055: 5c short
  const e = expected(sales, refunds, { float: FLOAT, counted });
  expect(e.overShort).toBe(-5);

  const zpage = await closeShiftOnScreen(page, orgId, counted);
  for (const cents of [e.amountDue, e.vat, e.expectedCash, counted]) {
    await expect(zpage).toContainText(exact(euro(cents)));
  }
  await expect(zpage).toContainText(/0\.05/);

  // Reports are built by a job that runs every few minutes: wait for it.
  const wantCount = (baseline ? Number(before.r![1]) : 0) + e.count;
  await expect
    .poll(
      async () => {
        const { r } = await dayRow(page, orgId, day);
        return r ? Number(r[1]) : 0;
      },
      { timeout: 600_000, intervals: [30_000] },
    )
    .toBe(wantCount);

  const { t } = await dayRow(page, orgId, day);
  if (!baseline && t) {
    expectRow(
      row(t, label),
      [e.count, e.amountDue, e.vat, e.discount, e.refunds.value, e.netTakings],
      [false, true, true, true, true, true],
    );
    await openReport(page, orgId, "vat", day);
    const v = await readTable(page);
    const pct = (bp: number) => `${bp / 100}%`;
    for (const bp of new Set([...e.byRate.keys(), ...e.refByRate.keys()])) {
      const s = e.byRate.get(bp) ?? { gross: 0, vat: 0, net: 0 };
      const r = e.refByRate.get(bp) ?? { gross: 0, vat: 0, net: 0 };
      const cols = [s.net, s.vat, s.gross, r.net, r.vat, r.gross, s.vat - r.vat];
      expectRow(
        row(v, pct(bp)),
        cols,
        cols.map(() => true),
      );
    }
    await openReport(page, orgId, "payments", day);
    const p = await readTable(page);
    for (const [m, name] of [
      ["cash", "Cash"],
      ["card", "Card"],
    ] as const) {
      expectRow(
        row(p, name),
        [
          e.tenderCount[m]!,
          e.tender[m]!,
          e.tipsBy[m]!,
          e.refTenderCount[m]!,
          e.refTender[m]!,
          e.tender[m]! - e.refTender[m]!,
        ],
        [false, true, true, false, true, true],
      );
    }
  }
  // Exports equal the screen, whether or not it is the first day on this shop.
  for (const report of ["sales-by-day", "vat", "payments"]) {
    await openReport(page, orgId, report, day);
    await checkExports(page, await readTable(page));
  }
});
