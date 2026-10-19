import { expect, test, type Page } from "@playwright/test";
import { config } from "dotenv";
import { buttonHydrated, hydrated, makePairingCode, setMyPin, unlockTill } from "../e2e/helpers";
import { byDim, euro, exact, expected, type Refund, type Sale } from "../e2e/day/ledger";
import {
  FLOAT,
  addMatrixProduct,
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
// ---------------------------------------------------------------- shared end of day (other types)

type Dim = "product" | "brand" | "sizeColour";

const TYPE_LABEL: Record<string, string> = {
  electronics: "Electronics & phones",
  clothing: "Clothing & footwear",
  cafe: "Café (counter service)",
  restaurant: "Restaurant (table service)",
};
let restoreType: (() => Promise<void>) | null = null;
test.afterEach(async () => {
  const r = restoreType;
  restoreType = null;
  await r?.();
});

async function setBusinessType(page: Page, orgId: string, label: string) {
  await page.goto(`/o/${orgId}/settings/business-type`);
  await hydrated(page);
  await page.getByText(label, { exact: true }).click();
  await page.getByRole("button", { name: "Save business type" }).click();
  await expect(page.getByRole("status")).toHaveText("Business type saved.");
}

/** Signs in with the type's own account; for café/restaurant without one, borrows the electronics
 * account, switches its business type in Settings, and switches it back after the test. */
async function startDay(page: Page, type: string) {
  let { email, password } = creds(type);
  let borrowed = false;
  if ((!email || !password) && (type === "cafe" || type === "restaurant")) {
    ({ email, password } = creds("electronics"));
    borrowed = true;
  }
  test.skip(!email || !password, `no STAGING_E2E_${type.toUpperCase()} account in .env.local`);
  const orgId = await signIn(page, email!, password!);
  if (borrowed) {
    await setBusinessType(page, orgId, TYPE_LABEL[type]!);
    restoreType = async () => {
      await setBusinessType(page, orgId, TYPE_LABEL.electronics!);
    };
  }
  const day = dublinDay();
  const before = await dayRow(page, orgId, day);
  return {
    orgId,
    day,
    before,
    baseline: before.r !== null,
    tag: Date.now().toString(36).slice(-4).toUpperCase(),
  };
}

/** Close the shift, then compare Z, sales by day, VAT, payments and the line reports with the ledger. */
async function endDay(
  page: Page,
  d: Awaited<ReturnType<typeof startDay>>,
  sales: Sale[],
  refunds: Refund[],
  counted: number,
  lineReports: [string, Dim][],
) {
  const { orgId, day, before, baseline } = d;
  const label = day.split("-").reverse().join("/");
  const e = expected(sales, refunds, { float: FLOAT, counted });
  const zpage = await closeShiftOnScreen(page, orgId, counted);
  for (const cents of [e.amountDue, e.vat, e.expectedCash, counted]) {
    await expect(zpage).toContainText(exact(euro(cents)));
  }
  await expect
    .poll(
      async () => {
        const { r } = await dayRow(page, orgId, day);
        return r ? Number(r[1]) : 0;
      },
      { timeout: 600_000, intervals: [30_000] },
    )
    .toBe((baseline ? Number(before.r![1]) : 0) + e.count);

  if (!baseline) {
    const { t } = await dayRow(page, orgId, day);
    expectRow(
      row(t!, label),
      [e.count, e.amountDue, e.vat, e.discount, e.refunds.value, e.netTakings],
      [false, true, true, true, true, true],
    );
    await openReport(page, orgId, "vat", day);
    const v = await readTable(page);
    for (const bp of new Set([...e.byRate.keys(), ...e.refByRate.keys()])) {
      const s = e.byRate.get(bp) ?? { gross: 0, vat: 0, net: 0 };
      const r = e.refByRate.get(bp) ?? { gross: 0, vat: 0, net: 0 };
      const cols = [s.net, s.vat, s.gross, r.net, r.vat, r.gross, s.vat - r.vat];
      expectRow(
        row(v, `${bp / 100}%`),
        cols,
        cols.map(() => true),
      );
    }
    await openReport(page, orgId, "payments", day);
    const p = await readTable(page);
    const names = {
      cash: "Cash",
      card: "Card",
      exchange: "Exchange credit",
    } as const;
    for (const m of ["cash", "card", "exchange"] as const) {
      if (!(e.tenderCount[m]! + e.refTenderCount[m]!)) continue;
      expectRow(
        row(p, names[m]),
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
    for (const [report, dim] of lineReports) {
      await openReport(page, orgId, report, day);
      const t2 = await readTable(page);
      const want = byDim(sales, refunds, dim);
      expect(t2.rows).toHaveLength(want.size);
      for (const [k, r] of want) {
        expectRow(
          row(t2, k),
          [r.qty, r.gross, r.net, r.vat, r.rQty, r.rGross, r.gross - r.rGross],
          [false, true, true, true, false, true, true],
        );
      }
    }
  }
  for (const report of ["sales-by-day", "vat", "payments", ...lineReports.map((l) => l[0])]) {
    await openReport(page, orgId, report, day);
    await checkExports(page, await readTable(page));
  }
}

// ---------------------------------------------------------------- electronics

test("staging · electronics: serials at the till, refund by IMEI, serials sold, brand report, exports", async ({
  page,
}) => {
  const d = await startDay(page, "electronics");
  const { orgId, tag } = d;
  const N = {
    x: `Phone X ${tag}`,
    z: `Phone Z ${tag}`,
    case: `Phone case ${tag}`,
  };
  const B = { acme: `Acme ${tag}`, zeta: `Zeta ${tag}` };
  const imei = (n: number) => `IMEI-${tag}-000${n}`;
  await addProduct(page, orgId, {
    name: N.x,
    price: "599",
    brand: B.acme,
    serial: true,
    stock: "5",
  });
  await addProduct(page, orgId, {
    name: N.z,
    price: "299",
    brand: B.zeta,
    serial: true,
    stock: "3",
  });
  await addProduct(page, orgId, {
    name: N.case,
    price: "19.99",
    brand: B.acme,
    stock: "20",
  });
  await openTillOnStaging(page, orgId);

  const sell = async (name: string, serial?: string) => {
    await tile(page, name).click();
    if (serial) {
      await page.getByLabel("Serial number / IMEI").fill(serial);
      await page.getByRole("button", { name: "Add to sale" }).click();
    }
  };
  await sell(N.x, imei(1));
  await sell(N.case);
  await payCard(page, 61899);
  await sell(N.z, imei(2));
  await payCash(page, 29900, "exact");
  await sell(N.x, imei(3));
  await payCard(page, 59900);

  await openRefund(page);
  await dialog(page).getByLabel("Serial / IMEI").fill(imei(1));
  await dialog(page).getByLabel("Serial / IMEI").press("Enter");
  await dialog(page)
    .getByRole("list", { name: "Find the sale" })
    .getByRole("button")
    .first()
    .click();
  await expect(dialog(page).getByText(`S/N ${imei(1)}`)).toBeVisible();
  await returnToCard(page, N.x);

  const line = (name: string, gross: number, brand: string) => ({
    name,
    gross,
    rateBp: 2300,
    product: name,
    brand,
  });
  const sales: Sale[] = [
    {
      key: "s1",
      lines: [line(N.x, 59900, B.acme), line(N.case, 1999, B.acme)],
      pays: [{ method: "card", amount: 61899 }],
    },
    {
      key: "s2",
      lines: [line(N.z, 29900, B.zeta)],
      pays: [{ method: "cash", amount: 29900 }],
    },
    {
      key: "s3",
      lines: [line(N.x, 59900, B.acme)],
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
  await endDay(page, d, sales, refunds, 39900, [
    ["sales-by-brand", "brand"],
    ["sales-by-product", "product"],
  ]);

  // Serials sold: one row per unit, the returned unit flagged; searching narrows it.
  await openReport(page, orgId, "serials", d.day);
  const t = await readTable(page);
  if (!d.baseline) {
    expect(t.rows).toHaveLength(3);
    for (const [n, item, returned] of [
      [1, N.x, "Yes"],
      [2, N.z, ""],
      [3, N.x, ""],
    ] as const) {
      const r = t.rows.find((x) => x[1] === imei(n))!;
      expect([r[2], r[4]]).toEqual([item, returned]);
    }
  }
  await checkExports(page, t);
  await page.goto(`/o/${orgId}/reports/serials?from=${d.day}&to=${d.day}&q=${imei(2)}`);
  const narrow = await readTable(page);
  expect(narrow.rows.map((r) => r[1])).toEqual([imei(2)]);
  await checkExports(page, narrow);
});

// ---------------------------------------------------------------- clothing

test("staging · clothing: variants, exchange, plain refund, size/colour report, gift receipt, exports", async ({
  page,
}) => {
  const d = await startDay(page, "clothing");
  const { orgId, tag } = d;
  const N = {
    tee: `Tee ${tag}`,
    kids: `Kids Tee ${tag}`,
    jacket: `Jacket ${tag}`,
  };
  await addMatrixProduct(page, orgId, {
    name: N.tee,
    sizes: ["S", "M"],
    colours: ["Black", "White"],
    price: "20",
    stock: {
      "S / Black": "5",
      "S / White": "5",
      "M / Black": "5",
      "M / White": "5",
    },
  });
  await addMatrixProduct(page, orgId, {
    name: N.kids,
    sizes: ["4Y"],
    colours: ["Red"],
    price: "15",
    vat: "ZERO",
    stock: { "4Y / Red": "5" },
  });
  await addMatrixProduct(page, orgId, {
    name: N.jacket,
    sizes: ["L"],
    colours: ["Navy"],
    price: "100",
    stock: { "L / Navy": "3" },
  });
  await openTillOnStaging(page, orgId);

  const pick = async (name: string, variant: string) => {
    await tile(page, name).click();
    await dialog(page)
      .getByRole("button", {
        name: new RegExp(`^${variant.replace(/[/]/g, "\\/")}`),
      })
      .click();
  };
  await pick(N.tee, "M / Black");
  await pick(N.tee, "S / White");
  await payCard(page, 4000);
  await tile(page, N.kids).click();
  await payCash(page, 1500, "exact");
  await tile(page, N.jacket).click();
  await payCard(page, 10000);

  // Exchange: the M / Black tee comes back as credit towards a jacket (dearer; the rest on the card).
  await tile(page, N.jacket).click();
  await openRefund(page);
  await pickRecent(page, 2);
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
  // Clothing offers a gift receipt on the sale-complete dialog.
  await expect(page.getByRole("button", { name: "Gift receipt" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
  await openRefund(page);
  await pickRecent(page, 3);
  await returnToCard(page, /.*S \/ White/);

  const sc = (
    name: string,
    gross: number,
    rateBp: number,
    product: string,
    sizeColour: string,
  ) => ({
    name,
    gross,
    rateBp,
    product,
    sizeColour,
  });
  const sales: Sale[] = [
    {
      key: "s1",
      lines: [
        sc(`${N.tee} M / Black`, 2000, 2300, N.tee, "M / Black"),
        sc(`${N.tee} S / White`, 2000, 2300, N.tee, "S / White"),
      ],
      pays: [{ method: "card", amount: 4000 }],
    },
    {
      key: "s2",
      lines: [sc(N.kids, 1500, 0, N.kids, "4Y / Red")],
      pays: [{ method: "cash", amount: 1500 }],
    },
    {
      key: "s3",
      lines: [sc(N.jacket, 10000, 2300, N.jacket, "L / Navy")],
      pays: [{ method: "card", amount: 10000 }],
    },
    {
      key: "s4",
      lines: [sc(N.jacket, 10000, 2300, N.jacket, "L / Navy")],
      pays: [
        { method: "exchange", amount: 2000 },
        { method: "card", amount: 8000 },
      ],
    },
  ];
  const refunds: Refund[] = [
    {
      sale: "s1",
      lines: [{ sale: "s1", line: 0, units: 1, of: 1 }],
      legs: [],
      credit: 2000,
    },
    {
      sale: "s1",
      lines: [{ sale: "s1", line: 1, units: 1, of: 1 }],
      legs: [{ method: "card", amount: 2000 }],
    },
  ];
  await endDay(page, d, sales, refunds, 11500, [
    ["sales-by-size-colour", "sizeColour"],
    ["sales-by-product", "product"],
  ]);
});
// ---------------------------------------------------------------- café

test("staging · café: required modifiers, eat-in and take-away VAT, card tip, refund, tips report, exports", async ({
  page,
}) => {
  const d = await startDay(page, "cafe");
  const { orgId, tag } = d;
  const N = {
    latte: `Latte ${tag}`,
    ham: `Ham sandwich ${tag}`,
    cola: `Cola ${tag}`,
  };
  const group = `Size ${tag}`;
  await page.goto(`/o/${orgId}/products/modifiers/new`);
  await hydrated(page);
  await page.getByLabel("Group name").fill(group);
  await page.getByLabel("Minimum choices").fill("1");
  await page.getByLabel("Maximum choices").fill("1");
  await page.getByLabel("Option name").fill("Small");
  await page.getByRole("button", { name: "Add option" }).click();
  await page.getByLabel("Option name").nth(1).fill("Large");
  await page.getByLabel("Extra price (can be negative)").nth(1).fill("0.50");
  await page.getByRole("button", { name: "Save group" }).click();
  await expect(page.getByRole("status")).toHaveText("Group saved.");
  await addProduct(page, orgId, {
    name: N.latte,
    price: "4.50",
    vat: "CATERING",
    group,
  });
  await addProduct(page, orgId, {
    name: N.ham,
    price: "5.00",
    vat: "CATERING",
    takeaway: "ZERO",
  });
  await addProduct(page, orgId, {
    name: N.cola,
    price: "2.50",
    vat: "STANDARD",
  });
  await openTillOnStaging(page, orgId);

  const latte = async (size: "Small" | "Large") => {
    await tile(page, N.latte).click();
    await page.getByRole("button", { name: new RegExp(`^${size}`) }).click();
    await dialog(page).getByRole("button", { name: /^Add/ }).click();
  };
  // S1: two large lattes, a sandwich and a cola, TAKE AWAY, on the card with a 1.00 tip.
  await latte("Large");
  await latte("Large");
  await tile(page, N.ham).click();
  await tile(page, N.cola).click();
  await page.getByRole("button", { name: "Take away", exact: true }).click();
  await payCard(page, 1750, { tip: "1.00" });
  // S2: a small latte and a sandwich eaten in, paid in cash.
  await latte("Small");
  await tile(page, N.ham).click();
  await payCash(page, 950, 2000);
  // Refund one large latte of S1 (the second newest sale).
  await openRefund(page);
  await pickRecent(page, 1);
  await returnToCard(page, new RegExp(N.latte));

  const sales: Sale[] = [
    {
      key: "s1",
      lines: [
        { name: N.latte, gross: 500, rateBp: 900, product: N.latte },
        { name: N.latte, gross: 500, rateBp: 900, product: N.latte },
        { name: N.ham, gross: 500, rateBp: 0, product: N.ham }, // take-away: 0%
        { name: N.cola, gross: 250, rateBp: 2300, product: N.cola },
      ],
      pays: [{ method: "card", amount: 1750, tip: 100 }],
    },
    {
      key: "s2",
      lines: [
        { name: N.latte, gross: 450, rateBp: 900, product: N.latte },
        { name: N.ham, gross: 500, rateBp: 900, product: N.ham }, // eat-in: 9%
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
  await endDay(page, d, sales, refunds, 10950, [["sales-by-product", "product"]]);

  const e = expected(sales, refunds, { float: FLOAT, counted: 10950 });
  await openReport(page, orgId, "tips", d.day);
  const t = await readTable(page);
  if (!d.baseline) {
    expect(t.rows).toHaveLength(1);
    expectRow(t.rows[0]!, [e.count, e.tips], [false, true]);
  }
  await checkExports(page, t);
});

// ---------------------------------------------------------------- restaurant

test("staging · restaurant: table, covers, split bill, service charge, card tip, refund, covers report, exports", async ({
  page,
}) => {
  const d = await startDay(page, "restaurant");
  const { orgId, tag } = d;
  const N = { soup: `Soup ${tag}`, steak: `Steak ${tag}`, wine: `Wine ${tag}` };
  const table = `T${tag}`;
  await addProduct(page, orgId, {
    name: N.soup,
    price: "6.00",
    vat: "CATERING",
  });
  await addProduct(page, orgId, {
    name: N.steak,
    price: "20.00",
    vat: "CATERING",
  });
  await addProduct(page, orgId, {
    name: N.wine,
    price: "8.00",
    vat: "STANDARD",
  });
  await page.goto(`/o/${orgId}/settings/service-charge`);
  await hydrated(page);
  await page.getByLabel(/^Service charge/).fill("10");
  await page.getByRole("button", { name: "Save service charge" }).click();
  await expect(page.getByRole("status")).toHaveText("Service charge saved.");
  await page.goto(`/o/${orgId}/settings/floor-plan`);
  await buttonHydrated(page, "Add table");
  await page.getByRole("button", { name: "Add table" }).click();
  await page.getByLabel("Table name").fill(table);
  await page.getByRole("button", { name: "Save floor plan" }).click();
  await expect(page.getByRole("status")).toHaveText("Floor plan saved.");
  await openTillOnStaging(page, orgId);

  const t1 = () => page.getByRole("button", { name: new RegExp(`^Table ${table}`) });
  const add = (name: string) => tile(page, name).click();
  // Four guests: seat 1 soup + steak, seat 2 soup + wine; split by seat.
  await t1().click();
  await page.getByLabel("How many guests?").fill("4");
  await page.getByRole("button", { name: "Open table", exact: true }).click();
  await add(N.soup);
  await add(N.steak);
  await page.getByRole("button", { name: "Next seat" }).click();
  await add(N.soup);
  await add(N.wine);
  await expect(page.getByRole("button", { name: "Pay €44.00" }).first()).toBeVisible(); // 40.00 + 10% service
  await page.getByRole("button", { name: "Bill", exact: true }).click();
  await page.getByRole("button", { name: "Split into 2 bills" }).click();
  await payCard(page, 2860, { tip: "3.00" }); // seat 1: 26.00 + 2.60 service
  await expect(page.getByRole("heading", { name: "Tables" })).toBeVisible();
  await t1().click();
  await payCash(page, 1540, "exact"); // seat 2: 14.00 + 1.40 service
  await expect(t1()).toContainText("Free");
  // Same table again, two guests, two steaks on one card payment.
  await t1().click();
  await page.getByLabel("How many guests?").fill("2");
  await page.getByRole("button", { name: "Open table", exact: true }).click();
  await add(N.steak);
  await add(N.steak);
  await payCard(page, 4400);
  // Return one steak; the service charge on it goes back with it.
  await openRefund(page);
  await pickRecent(page, 0);
  await returnToCard(page, N.steak);

  const svc = (name: string, gross: number, rateBp: number, qty = 1) => ({
    name: `Service charge ${name}`,
    gross,
    rateBp,
    qty,
    product: "Other (no product)",
  });
  const sales: Sale[] = [
    {
      key: "bill1",
      lines: [
        { name: N.soup, gross: 600, rateBp: 900, product: N.soup },
        { name: N.steak, gross: 2000, rateBp: 900, product: N.steak },
        svc("soup", 60, 900),
        svc("steak", 200, 900),
      ],
      pays: [{ method: "card", amount: 2860, tip: 300 }],
      fromTab: true,
    },
    {
      key: "bill2",
      lines: [
        { name: N.soup, gross: 600, rateBp: 900, product: N.soup },
        { name: N.wine, gross: 800, rateBp: 2300, product: N.wine },
        svc("soup", 60, 900),
        svc("wine", 80, 2300),
      ],
      pays: [{ method: "cash", amount: 1540 }],
      fromTab: true,
    },
    {
      key: "t2",
      lines: [
        { name: N.steak, gross: 4000, rateBp: 900, qty: 2, product: N.steak },
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
  await endDay(page, d, sales, refunds, 11540, [["sales-by-product", "product"]]);

  const e = expected(sales, refunds, { float: FLOAT, counted: 11540 });
  const covers = 4 + 2;
  const perCover = Math.round(e.amountDue / covers);
  await openReport(page, orgId, "covers", d.day);
  let t = await readTable(page);
  if (!d.baseline) {
    expect(t.rows).toHaveLength(1);
    expect(perCover).toBe(1467); // 8,800 / 6 = 14.666...
    expectRow(t.rows[0]!, [2, covers, e.amountDue, perCover], [false, false, true, true]);
  }
  await checkExports(page, t);
  await openReport(page, orgId, "tips", d.day);
  t = await readTable(page);
  if (!d.baseline) expectRow(t.rows[0]!, [e.count, e.tips], [false, true]);
  await checkExports(page, t);
});
