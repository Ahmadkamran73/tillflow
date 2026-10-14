import { expect, test, type Browser, type Page } from "@playwright/test";
import { config } from "dotenv";
import postgres from "postgres";
import { buttonHydrated, hydrated } from "./helpers";
import { byDim, euro, exact, expected, localParts, roundHalf, type Refund, type Sale } from "./day/ledger";
import {
  FLOAT,
  addMatrixProduct,
  addProduct,
  checkExports,
  checkIsolation,
  checkZ,
  closeShift,
  dialog,
  expectRow,
  openRefund,
  openReport,
  openRegister,
  payCard,
  payCash,
  pickRecent,
  readTable,
  rebuildSummaries,
  returnToCard,
  row,
  startShop,
  tile,
  waitCount,
  type Expected,
  type Table,
} from "./day/ui";

// One whole trading day for each of the five business types (the presets in
// src/config/business-type-presets.ts: general = retail, electronics, clothing, cafe, restaurant):
// set up the shop and its products, open a shift, sell with the type's own features and tenders,
// refund (and exchange where the type has it), close the shift, then check the numbers against an
// independent calculator (tests/e2e/day/ledger.ts): the stored sales, the server's Z-report, the
// back-office Z page, the dashboard, the reports, the CSV/Excel/PDF downloads against the table on
// screen, and finally that another business cannot reach any of it. Needs the local Supabase stack.

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(900_000);

type Ctx = { orgId: string; tz: string };

/** What a business type checks after the day, beyond the common checks. */
type Day = { ctx: Ctx; sales: Sale[]; refunds: Refund[]; counted: number };

// ---------------------------------------------------------------- the common part of every day

const dashTile = (page: Page, label: string) =>
  page.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });

async function closeAndCheck(page: Page, browser: Browser, d: Day) {
  const { orgId, tz } = d.ctx;
  const e = expected(d.sales, d.refunds, { float: FLOAT, counted: d.counted });
  await waitCount(sql, "sales", orgId, d.sales.length);
  await waitCount(sql, "refunds", orgId, d.refunds.length);

  // The server re-priced every sale on its own: it must agree with the independent ledger, and no
  // sale may carry a review flag.
  const stored = await sql`
    select receipt_seq, items_total_cents, vat_cents, amount_due_cents, review_flags, completed_at
    from sales where org_id = ${orgId} order by receipt_seq`;
  expect(stored).toHaveLength(d.sales.length);
  d.sales.forEach((s, i) => {
    const items = s.lines.reduce((n, l) => n + l.gross, 0);
    expect(stored[i], `stored sale ${s.key}`).toMatchObject({
      items_total_cents: items,
      amount_due_cents: s.pays.reduce((n, p) => n + p.amount, 0),
      review_flags: [],
    });
  });

  const z = await closeShift(page, sql, orgId, d.counted);
  expect(z.review_flags).toEqual([]);
  checkZ(z.report, e, d.counted);
  expect(z).toMatchObject({
    z_seq: 1,
    expected_cents: e.expectedCash,
    over_short_cents: e.overShort,
  });

  // The back-office page of that Z shows the same figures.
  await page.goto(`/o/${orgId}/shifts/${z.shift_id}`);
  const zpage = page.locator("main");
  for (const cents of [e.amountDue, e.vat, e.expectedCash, d.counted]) {
    await expect(zpage).toContainText(exact(euro(cents)));
  }

  // Shop-local day: every sale falls on one local day that is NOT the UTC day of the first sale.
  const first = new Date(stored[0]!.completed_at as string);
  const day = localParts(first, tz).day;
  for (const r of stored) expect(localParts(new Date(r.completed_at as string), tz).day).toBe(day);
  expect(day).not.toBe(first.toISOString().slice(0, 10));

  await rebuildSummaries(sql);
  return { e, day, z, stored };
}

type Common = Awaited<ReturnType<typeof closeAndCheck>>;

/** Tiles on the dashboard from the summary, against the ledger. */
async function checkDashboard(page: Page, orgId: string, e: Expected) {
  await page.goto(`/o/${orgId}/dashboard`);
  await expect(dashTile(page, "Sales today")).toContainText(exact(euro(e.netTakings)));
  await expect(dashTile(page, "Transactions")).toContainText(exact(String(e.count)));
  await expect(dashTile(page, "VAT collected")).toContainText(exact(euro(e.vat - e.refunds.vat)));
}

/** The general reports: sales by day, VAT by rate, payments, sales by hour; each exported and compared. */
async function checkGeneralReports(
  page: Page,
  d: Day,
  c: Common,
  hours: { sales: Map<string, [number, number, number]>; refunds: Map<string, [number, number]> },
) {
  const { orgId } = d.ctx;
  const { e, day } = c;
  const label = day.split("-").reverse().join("/");

  // Sales by day
  await openReport(page, orgId, "sales-by-day", day);
  let t = await readTable(page);
  expect(t.rows).toHaveLength(1);
  expectRow(
    row(t, label),
    [e.count, e.amountDue, e.vat, e.discount, e.refunds.value, e.netTakings],
    [false, true, true, true, true, true],
  );
  expectRow(
    t.totals!,
    [e.count, e.amountDue, e.vat, e.discount, e.refunds.value, e.netTakings],
    [false, true, true, true, true, true],
  );
  await checkExports(page, t);

  // VAT by rate: sales, refunds and the VAT left to pay, each its own column.
  await openReport(page, orgId, "vat", day);
  t = await readTable(page);
  const rates = new Set([...e.byRate.keys(), ...e.refByRate.keys()]);
  expect(t.rows).toHaveLength(rates.size);
  const pct = (bp: number) => `${bp / 100}%`;
  let sums = [0, 0, 0, 0, 0, 0, 0];
  for (const bp of rates) {
    const s = e.byRate.get(bp) ?? { gross: 0, vat: 0, net: 0 };
    const r = e.refByRate.get(bp) ?? { gross: 0, vat: 0, net: 0 };
    const cols = [s.net, s.vat, s.gross, r.net, r.vat, r.gross, s.vat - r.vat];
    expectRow(
      row(t, pct(bp)),
      cols,
      cols.map(() => true),
    );
    sums = sums.map((n, i) => n + cols[i]!);
  }
  expectRow(
    t.totals!,
    sums,
    sums.map(() => true),
  );
  expect(sums[1]).toBe(e.vat); // VAT by rate adds up to the day's VAT
  expect(sums[6]).toBe(e.vat - e.refunds.vat);
  await checkExports(page, t);

  // Payments by type
  await openReport(page, orgId, "payments", day);
  t = await readTable(page);
  const names = { cash: "Cash", card: "Card", exchange: "Exchange credit" } as const;
  for (const m of ["cash", "card", "exchange"] as const) {
    const used = e.tenderCount[m]! + e.refTenderCount[m]!;
    if (!used) {
      expect(t.rows.find((x) => x[0] === names[m])).toBeUndefined();
      continue;
    }
    expectRow(
      row(t, names[m]),
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
  await checkExports(page, t);

  // Sales by hour: the hour of each sale is read from its stored time with Intl, not by the app.
  await openReport(page, orgId, "sales-by-hour", day);
  t = await readTable(page);
  const allHours = new Set([...hours.sales.keys(), ...hours.refunds.keys()]);
  expect(t.rows).toHaveLength(allHours.size);
  for (const h of allHours) {
    const [n, gross, vat] = hours.sales.get(h) ?? [0, 0, 0];
    const [rn, rgross] = hours.refunds.get(h) ?? [0, 0];
    expectRow(row(t, h), [n, gross, vat, rn, rgross], [false, true, true, false, true]);
  }
  await checkExports(page, t);
}

/** Per local hour: sales (count, amount due, VAT) and refunds (count, value), from stored times + the ledger. */
async function hourMaps(d: Day, c: Common) {
  const { orgId, tz } = d.ctx;
  const hh = (iso: string) => `${String(localParts(new Date(iso), tz).hour).padStart(2, "0")}:00`;
  const sales = new Map<string, [number, number, number]>();
  const refunds = new Map<string, [number, number]>();
  c.stored.forEach((r, i) => {
    const s = d.sales[i]!;
    const k = hh(r.completed_at as string);
    const cur = sales.get(k) ?? [0, 0, 0];
    const vat = s.lines.reduce((n, l) => n + Math.round(0 + vatOf(l.gross, l.rateBp)), 0);
    sales.set(k, [cur[0] + 1, cur[1] + s.pays.reduce((n, p) => n + p.amount, 0), cur[2] + vat]);
  });
  const rrows =
    await sql`select completed_at from refunds where org_id = ${orgId} order by receipt_seq`;
  rrows.forEach((r, i) => {
    const rf = d.refunds[i]!;
    const value = rf.lines.reduce((n, rl) => {
      const l = d.sales.find((s) => s.key === rl.sale)!.lines[rl.line]!;
      return n + roundHalf(l.gross * rl.units, rl.of);
    }, 0);
    const k = hh(r.completed_at as string);
    const cur = refunds.get(k) ?? [0, 0];
    refunds.set(k, [cur[0] + 1, cur[1] + value]);
  });
  return { sales, refunds };
}
// The ledger's VAT rule again, for the hour table (kept local so the hour maths reads in one place).
const vatOf = (gross: number, bp: number) => roundHalf(gross * bp, 10000 + bp);

/** One line-report (product, brand, size/colour): rows against the ledger, then exported. */
async function checkLineReport(
  page: Page,
  d: Day,
  c: Common,
  report: string,
  dim: "product" | "brand" | "sizeColour",
) {
  await openReport(page, d.ctx.orgId, report, c.day);
  const t = await readTable(page);
  const want = byDim(d.sales, d.refunds, dim);
  expect(t.rows).toHaveLength(want.size);
  for (const [k, r] of want) {
    expectRow(
      row(t, k),
      [r.qty, r.gross, r.net, r.vat, r.rQty, r.rGross, r.gross - r.rGross],
      [false, true, true, true, false, true, true],
    );
  }
  await checkExports(page, t);
  return t;
}

async function finishWithIsolation(browser: Browser, d: Day, c: Common) {
  await checkIsolation(browser, sql, d.ctx.orgId, String(c.z.shift_id));
}

// ---------------------------------------------------------------- 1. general / retail

test("general store: barcode products, discount, deposit, 5c cash rounding, split tender, card refund, stock, Z and reports", async ({
  page,
  browser,
}) => {
  const ctx = await startShop(page, sql, "general", "general");
  const { orgId } = ctx;
  await addProduct(page, orgId, {
    name: "Tea bags",
    price: "12.34",
    barcode: "5012345678900",
    stock: "20",
  });
  await addProduct(page, orgId, {
    name: "Milk",
    price: "1.50",
    vat: "ZERO",
    barcode: "5012345678917",
    stock: "50",
  });
  await addProduct(page, orgId, {
    name: "Candle",
    price: "10.00",
    vat: "REDUCED",
    barcode: "5012345678924",
    stock: "10",
  });
  await addProduct(page, orgId, {
    name: "Cola can",
    price: "2.00",
    deposit: "0.15",
    barcode: "5012345678931",
    stock: "30",
  });
  await openRegister(page, orgId);

  // S1: cash, a 10% line discount on the milk, a can with its deposit; 15.84 rounds to 15.85.
  await tile(page, "Tea bags").click();
  await tile(page, "Milk").click();
  await tile(page, "Cola can").click();
  await page.getByRole("button", { name: "Discount on Milk" }).click();
  await page.getByRole("textbox", { name: "Percent (%)" }).fill("10");
  await page.getByRole("button", { name: "Apply discount" }).click();
  await payCash(page, 1584, 2000, 1585);
  // S2: two candles at 13.5% on the card.
  await tile(page, "Candle").click();
  await tile(page, "Candle").click();
  await payCard(page, 2000);
  // S3: two tea bags, 10.00 on the card and the rest in cash, rounded on the cash share only.
  await tile(page, "Tea bags").click();
  await tile(page, "Tea bags").click();
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
  await returnToCard(page, "Candle");

  const sales: Sale[] = [
    {
      key: "s1",
      lines: [
        { name: "Tea bags", gross: 1234, rateBp: 2300, product: "Tea bags" },
        { name: "Milk", gross: 135, rateBp: 0, discount: 15, product: "Milk" },
        { name: "Cola can", gross: 200, rateBp: 2300, product: "Cola can" },
      ],
      deposit: 15,
      pays: [{ method: "cash", amount: 1585 }],
    },
    {
      key: "s2",
      lines: [{ name: "Candle", gross: 2000, rateBp: 1350, qty: 2, product: "Candle" }],
      pays: [{ method: "card", amount: 2000 }],
    },
    {
      key: "s3",
      lines: [{ name: "Tea bags", gross: 2468, rateBp: 2300, qty: 2, product: "Tea bags" }],
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
  const d: Day = { ctx, sales, refunds, counted: 13050 }; // expected 13,055: 5c short
  const c = await closeAndCheck(page, browser, d);
  expect(c.e.overShort).toBe(-5);

  // Inventory: opening stock less sales plus the returned candle.
  const stock = await sql`
    select p.name, coalesce(sum(l.on_hand), 0)::int as n from products p
    join variants v on v.product_id = p.id and v.org_id = p.org_id
    left join stock_levels l on l.variant_id = v.id and l.org_id = v.org_id
    where p.org_id = ${orgId} group by p.name`;
  expect(Object.fromEntries(stock.map((r) => [r.name, r.n]))).toEqual({
    "Tea bags": 17,
    Milk: 49,
    Candle: 9,
    "Cola can": 29,
  });

  await checkDashboard(page, orgId, c.e);
  await checkGeneralReports(page, d, c, await hourMaps(d, c));
  await checkLineReport(page, d, c, "sales-by-product", "product");
  await finishWithIsolation(browser, d, c);
});

// ---------------------------------------------------------------- 2. electronics

test("electronics: serial numbers at the till, lookup by IMEI for a refund, serials sold, brand report, Z and reports", async ({
  page,
  browser,
}) => {
  const ctx = await startShop(page, sql, "electronics", "electronics");
  const { orgId } = ctx;
  await addProduct(page, orgId, {
    name: "Phone X",
    price: "599",
    brand: "Acme",
    serial: true,
    stock: "5",
  });
  await addProduct(page, orgId, {
    name: "Phone Z",
    price: "299",
    brand: "Zeta",
    serial: true,
    stock: "3",
  });
  await addProduct(page, orgId, { name: "Phone case", price: "19.99", brand: "Acme", stock: "20" });
  await openRegister(page, orgId);

  const sell = async (name: string, serial?: string) => {
    await tile(page, name).click();
    if (serial) {
      await page.getByLabel("Serial number / IMEI").fill(serial);
      await page.getByRole("button", { name: "Add to sale" }).click();
    }
  };
  await sell("Phone X", "IMEI-AAAA-0001");
  await sell("Phone case");
  await payCard(page, 61899);
  await sell("Phone Z", "IMEI-BBBB-0002");
  await payCash(page, 29900, "exact"); // electronics shops do not round cash to 5c
  await sell("Phone X", "IMEI-AAAA-0003");
  await payCard(page, 59900);

  // A bad serial is refused before the sale.
  await tile(page, "Phone Z").click();
  await page.getByLabel("Serial number / IMEI").fill("ab");
  await page.getByRole("button", { name: "Add to sale" }).click();
  await expect(page.getByText("Enter 4 to 40 letters, digits or dashes.")).toBeVisible();
  await dialog(page).getByRole("button", { name: "Cancel" }).click();

  // The customer brings back the first phone: found by its IMEI.
  await openRefund(page);
  await dialog(page).getByLabel("Serial / IMEI").fill("IMEI-AAAA-0001");
  await dialog(page).getByLabel("Serial / IMEI").press("Enter");
  await dialog(page)
    .getByRole("list", { name: "Find the sale" })
    .getByRole("button")
    .first()
    .click();
  await expect(dialog(page).getByText("S/N IMEI-AAAA-0001")).toBeVisible();
  await returnToCard(page, "Phone X");

  const sales: Sale[] = [
    {
      key: "s1",
      lines: [
        { name: "Phone X", gross: 59900, rateBp: 2300, product: "Phone X", brand: "Acme" },
        { name: "Phone case", gross: 1999, rateBp: 2300, product: "Phone case", brand: "Acme" },
      ],
      pays: [{ method: "card", amount: 61899 }],
    },
    {
      key: "s2",
      lines: [{ name: "Phone Z", gross: 29900, rateBp: 2300, product: "Phone Z", brand: "Zeta" }],
      pays: [{ method: "cash", amount: 29900 }],
    },
    {
      key: "s3",
      lines: [{ name: "Phone X", gross: 59900, rateBp: 2300, product: "Phone X", brand: "Acme" }],
      pays: [{ method: "card", amount: 59900 }],
    },
  ];
  const refunds: Refund[] = [
    {
      sale: "s1",
      lines: [{ sale: "s1", line: 0, units: 1, of: 1 }],
      legs: [{ method: "card", amount: 59900 }],
    },
  ];
  const d: Day = { ctx, sales, refunds, counted: 39900 };
  const c = await closeAndCheck(page, browser, d);

  // The serials on the server, one per unit, and the returned unit flagged.
  const serials =
    await sql`select serial from sale_lines where org_id = ${orgId} and serial is not null order by serial`;
  expect(serials.map((r) => r.serial)).toEqual([
    "IMEI-AAAA-0001",
    "IMEI-AAAA-0003",
    "IMEI-BBBB-0002",
  ]);

  await checkDashboard(page, orgId, c.e);
  await expect(dashTile(page, "Serials sold")).toContainText(exact("3"));
  await checkGeneralReports(page, d, c, await hourMaps(d, c));

  await openReport(page, orgId, "serials", c.day);
  const t: Table = await readTable(page);
  expect(t.rows).toHaveLength(3);
  const want: [string, string, string, string][] = [
    ["IMEI-AAAA-0001", "Phone X", "Till 1 · 000001", "Yes"],
    ["IMEI-BBBB-0002", "Phone Z", "Till 1 · 000002", ""],
    ["IMEI-AAAA-0003", "Phone X", "Till 1 · 000003", ""],
  ];
  for (const [serial, item, receipt, returned] of want) {
    const r = t.rows.find((x) => x[1] === serial)!;
    expect([r[2], r[3], r[4]]).toEqual([item, receipt, returned]);
    // The time column is the shop-local time of that sale.
    expect(r[0]).toMatch(/^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}$/);
  }
  await checkExports(page, t);
  // Searching by part of a serial narrows the report and its downloads.
  await page.goto(`/o/${orgId}/reports/serials?from=${c.day}&to=${c.day}&q=BBBB`);
  const narrow = await readTable(page);
  expect(narrow.rows.map((r) => r[1])).toEqual(["IMEI-BBBB-0002"]);
  await checkExports(page, narrow);

  await checkLineReport(page, d, c, "sales-by-brand", "brand");
  await checkLineReport(page, d, c, "sales-by-product", "product");
  await finishWithIsolation(browser, d, c);
});

// ---------------------------------------------------------------- 3. clothing

test("clothing: size and colour variants, exchange (dearer item), plain refund, size/colour report, Z and reports", async ({
  page,
  browser,
}) => {
  const ctx = await startShop(page, sql, "clothing", "clothing");
  const { orgId } = ctx;
  await addMatrixProduct(page, orgId, {
    name: "Tee",
    sizes: ["S", "M"],
    colours: ["Black", "White"],
    price: "20",
    stock: { "S / Black": "5", "S / White": "5", "M / Black": "5", "M / White": "5" },
  });
  await addMatrixProduct(page, orgId, {
    name: "Kids Tee",
    sizes: ["4Y"],
    colours: ["Red"],
    price: "15",
    vat: "ZERO",
    stock: { "4Y / Red": "5" },
  });
  await addMatrixProduct(page, orgId, {
    name: "Jacket",
    sizes: ["L"],
    colours: ["Navy"],
    price: "100",
    stock: { "L / Navy": "3" },
  });
  await openRegister(page, orgId);

  const pick = async (name: string, variant: string) => {
    await tile(page, name).click();
    await dialog(page)
      .getByRole("button", { name: new RegExp(`^${variant.replace(/[/]/g, "\\/")}`) })
      .click();
  };
  await pick("Tee", "M / Black");
  await pick("Tee", "S / White");
  await payCard(page, 4000);
  await tile(page, "Kids Tee").click();
  await payCash(page, 1500, "exact");
  await tile(page, "Jacket").click();
  await payCard(page, 10000);

  // Exchange: the M / Black tee comes back as credit towards a jacket (dearer; the rest on the card).
  await tile(page, "Jacket").click();
  await openRefund(page);
  await pickRecent(page, 2); // S1 is the third newest sale
  await page
    .getByRole("button", { name: /Return one more .*M \/ Black/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Exchange for other items" }).click();
  await dialog(page).getByLabel("Reason").selectOption("wrong_item");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await expect(dialog(page).getByText("Exchange credit: €20.00")).toBeVisible();
  await page.getByRole("button", { name: "Complete exchange" }).click();
  await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
  await page.getByRole("button", { name: "Card", exact: true }).click();
  await expect(page.getByLabel("Card amount")).toHaveValue("80.00");
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  // A plain refund of the S / White tee (S1 is now the fourth newest sale).
  await openRefund(page);
  await pickRecent(page, 3);
  await returnToCard(page, /.*S \/ White/);

  const sales: Sale[] = [
    {
      key: "s1",
      lines: [
        {
          name: "Tee M / Black",
          gross: 2000,
          rateBp: 2300,
          product: "Tee",
          sizeColour: "M / Black",
        },
        {
          name: "Tee S / White",
          gross: 2000,
          rateBp: 2300,
          product: "Tee",
          sizeColour: "S / White",
        },
      ],
      pays: [{ method: "card", amount: 4000 }],
    },
    {
      key: "s2",
      lines: [
        { name: "Kids Tee", gross: 1500, rateBp: 0, product: "Kids Tee", sizeColour: "4Y / Red" },
      ],
      pays: [{ method: "cash", amount: 1500 }],
    },
    {
      key: "s3",
      lines: [
        { name: "Jacket", gross: 10000, rateBp: 2300, product: "Jacket", sizeColour: "L / Navy" },
      ],
      pays: [{ method: "card", amount: 10000 }],
    },
    {
      key: "s4",
      lines: [
        { name: "Jacket", gross: 10000, rateBp: 2300, product: "Jacket", sizeColour: "L / Navy" },
      ],
      pays: [
        { method: "exchange", amount: 2000 },
        { method: "card", amount: 8000 },
      ],
    },
  ];
  const refunds: Refund[] = [
    { sale: "s1", lines: [{ sale: "s1", line: 0, units: 1, of: 1 }], legs: [], credit: 2000 },
    {
      sale: "s1",
      lines: [{ sale: "s1", line: 1, units: 1, of: 1 }],
      legs: [{ method: "card", amount: 2000 }],
    },
  ];
  const d: Day = { ctx, sales, refunds, counted: 11500 };
  const c = await closeAndCheck(page, browser, d);
  // The exchange is one refund of kind "exchange" with credit and no money paid out.
  const kinds =
    await sql`select kind, credit_cents, amount_cents from refunds where org_id = ${orgId} order by receipt_seq`;
  expect(kinds.map((r) => [r.kind, r.credit_cents, r.amount_cents])).toEqual([
    ["exchange", 2000, 0],
    ["refund", 0, 2000],
  ]);

  await checkDashboard(page, orgId, c.e);
  await checkGeneralReports(page, d, c, await hourMaps(d, c));
  await checkLineReport(page, d, c, "sales-by-size-colour", "sizeColour");
  await checkLineReport(page, d, c, "sales-by-product", "product");
  await finishWithIsolation(browser, d, c);
});

// ---------------------------------------------------------------- 4. café

test("café: required modifiers, eat-in and take-away VAT, card tip, refund, tips report, Z and reports", async ({
  page,
  browser,
}) => {
  const ctx = await startShop(page, sql, "cafe", "cafe");
  const { orgId } = ctx;
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
  await addProduct(page, orgId, { name: "Latte", price: "4.50", vat: "CATERING", group: "Size" });
  await addProduct(page, orgId, {
    name: "Ham sandwich",
    price: "5.00",
    vat: "CATERING",
    takeaway: "ZERO",
  });
  await addProduct(page, orgId, { name: "Cola", price: "2.50", vat: "STANDARD" });
  await openRegister(page, orgId);

  const latte = async (size: "Small" | "Large") => {
    await tile(page, "Latte").click();
    await page.getByRole("button", { name: new RegExp(`^${size}`) }).click();
    await dialog(page).getByRole("button", { name: /^Add/ }).click();
  };
  // S1: two large lattes, a sandwich and a cola, TAKE AWAY, on the card with a 1.00 tip.
  await latte("Large");
  await latte("Large");
  await tile(page, "Ham sandwich").click();
  await tile(page, "Cola").click();
  await page.getByRole("button", { name: "Take away", exact: true }).click();
  await payCard(page, 1750, { tip: "1.00" });
  // S2: a small latte and a sandwich eaten in, paid in cash.
  await latte("Small");
  await tile(page, "Ham sandwich").click();
  await payCash(page, 950, 2000);
  // Refund one large latte of S1 (the second newest sale).
  await openRefund(page);
  await pickRecent(page, 1);
  await returnToCard(page, /Latte/);

  const sales: Sale[] = [
    {
      key: "s1",
      lines: [
        { name: "Latte", gross: 500, rateBp: 900, product: "Latte" },
        { name: "Latte", gross: 500, rateBp: 900, product: "Latte" },
        { name: "Ham sandwich", gross: 500, rateBp: 0, product: "Ham sandwich" }, // take-away: 0%
        { name: "Cola", gross: 250, rateBp: 2300, product: "Cola" },
      ],
      pays: [{ method: "card", amount: 1750, tip: 100 }],
    },
    {
      key: "s2",
      lines: [
        { name: "Latte", gross: 450, rateBp: 900, product: "Latte" },
        { name: "Ham sandwich", gross: 500, rateBp: 900, product: "Ham sandwich" }, // eat-in: 9%
      ],
      pays: [{ method: "cash", amount: 950 }],
    },
  ];
  const refunds: Refund[] = [
    {
      sale: "s1",
      lines: [{ sale: "s1", line: 0, units: 1, of: 1 }],
      legs: [{ method: "card", amount: 500 }],
    },
  ];
  const d: Day = { ctx, sales, refunds, counted: 10950 };
  const c = await closeAndCheck(page, browser, d);
  const modes = await sql`select mode from sales where org_id = ${orgId} order by receipt_seq`;
  expect(modes.map((m) => m.mode)).toEqual(["take_away", "eat_in"]);

  await checkDashboard(page, orgId, c.e);
  await expect(dashTile(page, "Tips")).toContainText(exact(euro(c.e.tips)));
  await checkGeneralReports(page, d, c, await hourMaps(d, c));

  await openReport(page, orgId, "tips", c.day);
  const t = await readTable(page);
  expect(t.rows).toHaveLength(1);
  expectRow(t.rows[0]!, [c.e.count, c.e.tips], [false, true]);
  await checkExports(page, t);
  await checkLineReport(page, d, c, "sales-by-product", "product");
  await finishWithIsolation(browser, d, c);
});

// ---------------------------------------------------------------- 5. restaurant

test("restaurant: table, covers, seats, split bill, service charge, card tip, refund, covers report, Z and reports", async ({
  page,
  browser,
}) => {
  const ctx = await startShop(page, sql, "restaurant", "restaurant");
  const { orgId } = ctx;
  await addProduct(page, orgId, { name: "Soup", price: "6.00", vat: "CATERING" });
  await addProduct(page, orgId, { name: "Steak", price: "20.00", vat: "CATERING" });
  await addProduct(page, orgId, { name: "Wine", price: "8.00", vat: "STANDARD" });
  await page.goto(`/o/${orgId}/settings/service-charge`);
  await hydrated(page);
  await page.getByLabel(/^Service charge/).fill("10");
  await page.getByRole("button", { name: "Save service charge" }).click();
  await expect(page.getByRole("status")).toHaveText("Service charge saved.");
  await page.goto(`/o/${orgId}/settings/floor-plan`);
  await buttonHydrated(page, "Add table");
  await page.getByRole("button", { name: "Add table" }).click();
  await page.getByLabel("Table name").fill("T1");
  await page.getByRole("button", { name: "Save floor plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Floor plan saved.");
  await openRegister(page, orgId);

  const t1 = () => page.getByRole("button", { name: /^Table T1/ });
  const add = (name: string) => tile(page, name).click();
  // Table 1, four guests: seat 1 soup + steak, seat 2 soup + wine; split by seat.
  await t1().click();
  await page.getByLabel("How many guests?").fill("4");
  await page.getByRole("button", { name: "Open table", exact: true }).click();
  await add("Soup");
  await add("Steak");
  await page.getByRole("button", { name: "Next seat" }).click();
  await add("Soup");
  await add("Wine");
  await expect(page.getByRole("button", { name: "Pay €44.00" }).first()).toBeVisible(); // 40.00 + 10% service
  await page.getByRole("button", { name: "Bill", exact: true }).click();
  await page.getByRole("button", { name: "Split into 2 bills" }).click();
  await payCard(page, 2860, { tip: "3.00" }); // seat 1: 26.00 + 2.60 service
  await expect(page.getByRole("heading", { name: "Tables" })).toBeVisible();
  await t1().click();
  await payCash(page, 1540, "exact"); // seat 2: 14.00 + 1.40 service
  await expect(t1()).toContainText("Free");
  // Table 1 again, two guests, two steaks on one card payment.
  await t1().click();
  await page.getByLabel("How many guests?").fill("2");
  await page.getByRole("button", { name: "Open table", exact: true }).click();
  await add("Steak");
  await add("Steak");
  await payCard(page, 4400);
  // Return one steak; the service charge on it goes back with it.
  await openRefund(page);
  await pickRecent(page, 0);
  await returnToCard(page, "Steak");

  const svc = (name: string, gross: number, rateBp: number, qty = 1) => ({
    name: `Service charge ${name}`,
    gross,
    rateBp,
    qty,
    // No product: the product report files service charge lines under "Other (no product)".
    product: "Other (no product)",
  });
  const sales: Sale[] = [
    {
      key: "bill1",
      lines: [
        { name: "Soup", gross: 600, rateBp: 900, product: "Soup" },
        { name: "Steak", gross: 2000, rateBp: 900, product: "Steak" },
        svc("soup", 60, 900),
        svc("steak", 200, 900),
      ],
      pays: [{ method: "card", amount: 2860, tip: 300 }],
      fromTab: true,
    },
    {
      key: "bill2",
      lines: [
        { name: "Soup", gross: 600, rateBp: 900, product: "Soup" },
        { name: "Wine", gross: 800, rateBp: 2300, product: "Wine" },
        svc("soup", 60, 900),
        svc("wine", 80, 2300),
      ],
      pays: [{ method: "cash", amount: 1540 }],
      fromTab: true,
    },
    {
      key: "t2",
      lines: [
        { name: "Steak", gross: 4000, rateBp: 900, qty: 2, product: "Steak" },
        svc("steaks", 400, 900, 2),
      ],
      pays: [{ method: "card", amount: 4400 }],
      fromTab: true,
    },
  ];
  const refunds: Refund[] = [
    {
      sale: "t2",
      lines: [
        { sale: "t2", line: 0, units: 1, of: 2 },
        { sale: "t2", line: 1, units: 1, of: 2 },
      ],
      legs: [{ method: "card", amount: 2200 }],
    },
  ];
  const d: Day = { ctx, sales, refunds, counted: 11540 };
  const c = await closeAndCheck(page, browser, d);
  // Service charge lines are stored at their item's own rate, and the sales came from tabs.
  const svcLines =
    await sql`select tax_rate_bp, count(*)::int as n from sale_lines where org_id = ${orgId} and name like 'Service charge%' group by tax_rate_bp order by tax_rate_bp`;
  expect(svcLines.map((r) => [r.tax_rate_bp, r.n])).toEqual([
    [900, 4], // bill 1 soup and steak, bill 2 soup, the two steaks
    [2300, 1], // bill 2 wine
  ]);
  expect(
    Number(
      (
        await sql`select count(distinct tab_id)::int as n from sale_tabs where org_id = ${orgId}`
      )[0]!.n,
    ),
  ).toBe(2);

  const covers = 4 + 2;
  const fromTabs = c.e.amountDue; // every sale of the day was paid from a tab
  const perCover = roundHalf(fromTabs, covers);
  expect(perCover).toBe(1467); // 8,800 / 6 = 14.666...

  await checkDashboard(page, orgId, c.e);
  await expect(dashTile(page, "Covers")).toContainText(exact(String(covers)));
  await expect(dashTile(page, "Spend per cover")).toContainText(exact(euro(perCover)));
  await expect(dashTile(page, "Tips")).toContainText(exact(euro(c.e.tips)));
  await checkGeneralReports(page, d, c, await hourMaps(d, c));

  await openReport(page, orgId, "covers", c.day);
  let t = await readTable(page);
  expect(t.rows).toHaveLength(1);
  expectRow(t.rows[0]!, [2, covers, fromTabs, perCover], [false, false, true, true]);
  await checkExports(page, t);

  await openReport(page, orgId, "tips", c.day);
  t = await readTable(page);
  expectRow(t.rows[0]!, [c.e.count, c.e.tips], [false, true]);
  await checkExports(page, t);
  await checkLineReport(page, d, c, "sales-by-product", "product");
  await finishWithIsolation(browser, d, c);
});
