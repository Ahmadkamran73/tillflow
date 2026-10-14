import { expect, type Browser, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type postgres from "postgres";
import type { BusinessType } from "@/config/business-type-presets";
import { enIE } from "@/lib/i18n/en-IE";
import { hydrated, openDashboard, openTill, signUpAndEnrol, uniqueEmail } from "../helpers";
import { euro, offsetZone, type expected } from "./ledger";

export type Sql = postgres.Sql;
export type Expected = ReturnType<typeof expected>;
export const FLOAT = 10_000; // the till helper opens every shift with 100.00

// ---------------------------------------------------------------- shop set-up

/** Signs up, onboards as `type`, and moves the shop to a zone whose local day is not the UTC day. */
export async function startShop(page: Page, sql: Sql, label: string, type: BusinessType) {
  await page.addInitScript(() => {
    window.print = () => {};
  });
  await signUpAndEnrol(page, uniqueEmail(`day-${label}`), `E2E day ${label}`);
  const orgId = await openDashboard(page, { type: enIE[`businessType.${type}`] });
  const tz = offsetZone();
  await sql`update locations set timezone = ${tz} where org_id = ${orgId}`;
  return { orgId, tz };
}

export type ProductSpec = {
  name: string;
  price: string;
  category?: string;
  vat?: string; // a rate category value: STANDARD, REDUCED, ZERO, CATERING ...
  takeaway?: string;
  barcode?: string;
  deposit?: string;
  stock?: string;
  age?: boolean;
  brand?: string;
  serial?: boolean;
  group?: string;
};

const save = async (page: Page) => {
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
};

export async function addProduct(page: Page, orgId: string, p: ProductSpec) {
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill(p.name);
  if (p.category) await page.getByLabel("Category").selectOption({ label: p.category });
  if (p.vat) await page.getByLabel("VAT rate", { exact: true }).selectOption(p.vat);
  if (p.takeaway) await page.getByLabel("VAT rate when taken away").selectOption(p.takeaway);
  await page.getByLabel("Price (including VAT)").fill(p.price);
  if (p.barcode) await page.getByLabel("Barcode").fill(p.barcode);
  if (p.deposit) await page.getByLabel("Re-turn deposit").fill(p.deposit);
  if (p.stock) await page.getByLabel("Opening stock").fill(p.stock);
  if (p.age) await page.getByLabel("Age-restricted (ask for ID)").check();
  if (p.brand) await page.getByLabel("Brand").fill(p.brand);
  if (p.serial) await page.getByLabel("Ask for a serial or IMEI on every sale").check();
  if (p.group)
    await page.getByRole("group", { name: "Modifier groups" }).getByLabel(p.group).check();
  await save(page);
}

/** A clothing product: sizes x colours, one price, opening stock per variant (`stock[size / colour]`). */
export async function addMatrixProduct(
  page: Page,
  orgId: string,
  p: {
    name: string;
    sizes: string[];
    colours: string[];
    price: string;
    vat?: string;
    stock?: Record<string, string>;
  },
) {
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill(p.name);
  if (p.vat) await page.getByLabel("VAT rate", { exact: true }).selectOption(p.vat);
  for (const [label, values] of [
    ["Sizes", p.sizes],
    ["Colours", p.colours],
  ] as const) {
    const box = page.getByLabel(label, { exact: true });
    for (const v of values) {
      await box.fill(v);
      await box.press("Enter");
    }
  }
  const table = page.getByRole("table", { name: /Variants/ });
  for (const size of p.sizes) {
    for (const colour of p.colours) {
      const v = `${size} / ${colour}`;
      await table.getByLabel(`Price (including VAT), ${v}`).fill(p.price);
      const stock = p.stock?.[v];
      if (stock) await table.getByLabel(`Opening stock, ${v}`).fill(stock);
    }
  }
  await save(page);
}

export const openRegister = (page: Page, orgId: string) => openTill(page, orgId);

// ---------------------------------------------------------------- the till

export const tile = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`^${name}`) });
export const dialog = (page: Page) => page.getByRole("dialog");
const choose = (page: Page, name: string) =>
  page.getByRole("button", { name, exact: true }).click();

async function finishSale(page: Page) {
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
}

export async function startPay(page: Page, total: number) {
  await page
    .getByRole("button", { name: `Pay ${euro(total)}` })
    .first()
    .click();
  await expect(page.getByRole("heading", { name: "Take payment" })).toBeVisible();
}

/** Cash, with a quick-cash button (`exact` for the exact amount). Shows the rounded cash due. */
export async function payCash(page: Page, total: number, tender: number | "exact", due?: number) {
  await startPay(page, total);
  await choose(page, "Cash");
  if (due !== undefined) await expect(page.getByText(`Cash due: ${euro(due)}`)).toBeVisible();
  if (tender === "exact") await page.getByRole("button", { name: /^Exact/ }).click();
  else await page.getByRole("button", { name: euro(tender), exact: true }).click();
  await finishSale(page);
}

export async function payCard(page: Page, total: number, opts: { tip?: string } = {}) {
  await startPay(page, total);
  await choose(page, "Card");
  if (opts.tip) await page.getByLabel(/^Tip/).fill(opts.tip);
  await page.getByRole("button", { name: "Approved on terminal" }).click();
  await page.getByRole("button", { name: "Complete sale" }).click();
  await finishSale(page);
}

export const waitCount = (sql: Sql, table: "sales" | "refunds", orgId: string, n: number) =>
  expect
    .poll(
      async () =>
        Number(
          (await sql`select count(*)::int as n from ${sql(table)} where org_id = ${orgId}`)[0]!.n,
        ),
      { timeout: 60_000 },
    )
    .toBe(n);

// ---------------------------------------------------------------- refunds

export async function openRefund(page: Page) {
  await page.getByRole("button", { name: "Refund", exact: true }).click();
  await expect(dialog(page).getByRole("heading", { name: "Find the sale" })).toBeVisible();
}

/** Opens the n-th newest sale in the recent list (0 = newest). */
export const pickRecent = (page: Page, n: number) =>
  dialog(page)
    .getByRole("button", { name: /Till 1 · \d{6}/ })
    .nth(n)
    .click();

/** Returns `times` units of the line called `item`, to the card; the sale is chosen by the caller. */
export async function returnToCard(
  page: Page,
  item: RegExp | string,
  opts: { times?: number; reason?: string } = {},
) {
  const more = page.getByRole("button", {
    name:
      typeof item === "string"
        ? `Return one more ${item}`
        : new RegExp(`^Return one more ${item.source}`),
  });
  for (let i = 0; i < (opts.times ?? 1); i++) await more.first().click();
  await dialog(page)
    .getByLabel("Reason")
    .selectOption(opts.reason ?? "faulty");
  await page.getByRole("button", { name: "Next: pay back" }).click();
  await page.getByRole("button", { name: "Complete refund" }).click();
  await expect(dialog(page).getByRole("heading", { name: "Refund saved" })).toBeVisible();
  await page.getByRole("button", { name: "Back to the till" }).click();
}

// ---------------------------------------------------------------- shift

/** Closes the shift counting `counted` cents in the drawer; returns the stored Z and shift id. */
export async function closeShift(page: Page, sql: Sql, orgId: string, counted: number) {
  await page.getByRole("button", { name: "Shift" }).click();
  await page.getByRole("button", { name: "Close shift" }).click();
  await page.getByLabel("Cash counted (€)").fill((counted / 100).toFixed(2));
  await page.getByRole("button", { name: "Close shift and print Z-report" }).click();
  await expect(page.getByRole("heading", { name: "Shift closed" })).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();
  await expect
    .poll(
      async () =>
        Number(
          (await sql`select count(*)::int as n from shift_closes where org_id = ${orgId}`)[0]!.n,
        ),
      { timeout: 60_000 },
    )
    .toBe(1);
  const [z] = await sql`select shift_id, z_seq, counted_cents, expected_cents, over_short_cents,
                               review_flags, report from shift_closes where org_id = ${orgId}`;
  return z!;
}

type Z = {
  sales: { count: number; amount_due_cents: number; vat_cents: number; discount_cents: number };
  vat_by_rate: { rate_bp: number; net_cents: number; vat_cents: number; gross_cents: number }[];
  tenders: { method: string; payments: number; amount_cents: number; tip_cents: number }[];
  tips_cents: number;
  refunds: { count: number; amount_cents: number; credit_cents: number; vat_cents: number };
  refund_vat_by_rate: {
    rate_bp: number;
    net_cents: number;
    vat_cents: number;
    gross_cents: number;
  }[];
  drawer: {
    float_cents: number;
    cash_sales_cents: number;
    cash_refunds_cents: number;
    expected_cents: number;
  };
  counted_cents: number;
  over_short_cents: number;
};

/** The server's stored Z against the independently calculated day. */
export function checkZ(report: unknown, e: Expected, counted: number) {
  const z = report as Z;
  expect(z.sales).toMatchObject({
    count: e.count,
    amount_due_cents: e.amountDue,
    vat_cents: e.vat,
    discount_cents: e.discount,
  });
  const rate = (rows: Z["vat_by_rate"]) =>
    Object.fromEntries(rows.map((r) => [r.rate_bp, [r.gross_cents, r.vat_cents, r.net_cents]]));
  expect(rate(z.vat_by_rate)).toEqual(
    Object.fromEntries([...e.byRate].map(([k, v]) => [k, [v.gross, v.vat, v.net]])),
  );
  expect(rate(z.refund_vat_by_rate)).toEqual(
    Object.fromEntries([...e.refByRate].map(([k, v]) => [k, [v.gross, v.vat, v.net]])),
  );
  const taken = Object.fromEntries(z.tenders.map((t) => [t.method, t.amount_cents]));
  for (const m of ["cash", "card", "exchange"]) expect(taken[m] ?? 0).toBe(e.tender[m]);
  expect(z.tips_cents).toBe(e.tips);
  expect(z.refunds).toMatchObject({
    count: e.refunds.count,
    amount_cents: e.refunds.money,
    credit_cents: e.refunds.credit,
    vat_cents: e.refunds.vat,
  });
  expect(z.drawer).toMatchObject({
    float_cents: FLOAT,
    cash_sales_cents: e.tender.cash,
    cash_refunds_cents: e.refTender.cash,
    expected_cents: e.expectedCash,
  });
  expect(z.counted_cents).toBe(counted);
  expect(z.over_short_cents).toBe(e.overShort);
}

// ---------------------------------------------------------------- reports and exports

export type Table = { header: string[]; rows: string[][]; totals: string[] | null };

export async function openReport(page: Page, orgId: string, report: string, day: string) {
  await page.goto(`/o/${orgId}/reports/${report}?from=${day}&to=${day}`);
  await expect(page.getByTestId("report-table")).toBeVisible();
}

export async function readTable(page: Page): Promise<Table> {
  const region = page.getByTestId("report-table");
  const cells = (sel: string) =>
    region
      .locator(sel)
      .evaluateAll((trs) =>
        trs.map((tr) => [...tr.children].map((c) => (c.textContent ?? "").trim())),
      );
  const header = (await cells("thead tr"))[0] ?? [];
  const totals = (await cells("tfoot tr"))[0] ?? null;
  return { header, rows: await cells("tbody tr"), totals };
}

/** "€1,234.50" -> "1234.50", "-€0.45" -> "-0.45"; other text unchanged. */
export const plain = (s: string) => s.replace(/€/g, "").replace(/,/g, "");
const isNum = (s: string) => /^-?\d+(\.\d+)?$/.test(s);
const same = (a: string, b: string) =>
  isNum(plain(a)) && isNum(plain(b)) ? Number(plain(a)) === Number(plain(b)) : a === b;

/** The row whose first cell is `first`, as plain strings. */
export function row(t: Table, first: string | RegExp) {
  const r = t.rows.find((x) =>
    typeof first === "string" ? x[0] === first : first.test(x[0] ?? ""),
  );
  if (!r) throw new Error(`no row "${first}" in: ${t.rows.map((x) => x[0]).join(", ")}`);
  return r;
}

/** Cells of `r` after the first, compared with euro()/count expectations (numbers are cents or counts). */
export function expectRow(r: string[], want: (number | string)[], money: boolean[]) {
  want.forEach((w, i) => {
    const got = r[i + 1] ?? "";
    const exp = typeof w === "string" ? w : money[i] ? euro(w) : String(w);
    expect(got, `column ${i + 2} of ${r[0]}`).toBe(exp);
  });
}

function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let cell = "";
  let line: string[] = [];
  let q = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      line.push(cell);
      cell = "";
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      line.push(cell);
      out.push(line);
      line = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || line.length) {
    line.push(cell);
    out.push(line);
  }
  return out;
}

const pdfScript = join(__dirname, "pdf-text.mjs");

/** Text of every page of a PDF (extracted in a child process: pdfjs is an ES module). */
export function pdfText(bytes: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "tillflow-pdf-"));
  const file = join(dir, "export.pdf");
  writeFileSync(file, bytes);
  return execFileSync(process.execPath, [pdfScript, file], {
    encoding: "utf8",
    maxBuffer: 20_000_000,
  });
}

/**
 * Downloads the report as CSV, Excel and PDF (through the page's own download links, with its
 * session) and checks each against the table on screen: same header, same rows, same totals.
 */
export async function checkExports(page: Page, screen: Table) {
  const link = (name: string) => page.getByRole("link", { name: new RegExp(`^${name}`) });
  const get = async (name: string) => {
    const res = await page.request.get((await link(name).getAttribute("href"))!);
    expect(res.status(), `${name} download`).toBe(200);
    return res;
  };
  const want = [...screen.rows, ...(screen.totals ? [screen.totals] : [])];

  // CSV
  const csv = parseCsv(await (await get("CSV")).text());
  expect(csv[0]).toEqual(screen.header);
  expect(csv.slice(1)).toHaveLength(want.length);
  want.forEach((r, i) =>
    r.forEach((c, j) =>
      expect(same(c, csv[i + 1]![j] ?? ""), `csv r${i}c${j}: ${c} vs ${csv[i + 1]![j]}`).toBe(true),
    ),
  );

  // Excel: the header is on row 4, then the rows, then the totals; money cells are numbers.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await (await get("Excel")).body()) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0]!;
  const grid: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n >= 4)
      grid.push(
        (r.values as unknown[])
          .slice(1)
          .map((v) => (v === null || v === undefined ? "" : String(v))),
      );
  });
  expect(grid[0]).toEqual(screen.header);
  want.forEach((r, i) =>
    r.forEach((c, j) =>
      expect(same(c, grid[i + 1]![j] ?? ""), `xlsx r${i}c${j}: ${c} vs ${grid[i + 1]![j]}`).toBe(
        true,
      ),
    ),
  );

  // PDF: valid, and every value on screen is printed on it.
  const pdf = await (await get("PDF")).body();
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  // Compared without spaces: the PDF may split a value into pieces at a kerning pair ("4" "Y / Red").
  const text = pdfText(Buffer.from(pdf)).replace(/\s+/g, "");
  for (const r of want)
    for (const c of r)
      if (c !== "") expect(text, `pdf has "${c}"`).toContain(c.replace(/\s+/g, ""));
}

// ---------------------------------------------------------------- isolation

/**
 * Another business signs up; it must not reach any of this business's pages, files or exports, and
 * its own reports must be empty.
 */
export async function checkIsolation(browser: Browser, sql: Sql, orgId: string, shiftId: string) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  try {
    const other = await ctx.newPage();
    await signUpAndEnrol(other, uniqueEmail("day-other"), "E2E other shop");
    const otherOrg = await openDashboard(other);
    expect(otherOrg).not.toBe(orgId);

    for (const path of [
      `/o/${orgId}/dashboard`,
      `/o/${orgId}/reports`,
      `/o/${orgId}/reports/vat`,
      `/o/${orgId}/reports/sales-by-day`,
      `/o/${orgId}/shifts/${shiftId}`,
      `/o/${orgId}/sales`,
      `/o/${orgId}/settings/export`,
    ]) {
      const res = await other.goto(path);
      expect(res?.status(), `${path} for another business`).toBe(404);
    }
    for (const path of [
      `/o/${orgId}/reports/vat/export?format=csv&from=2020-01-01&to=2099-12-31`,
      `/o/${orgId}/reports/vat/export?format=xlsx&from=2020-01-01&to=2099-12-31`,
      `/o/${orgId}/reports/vat/export?format=pdf&from=2020-01-01&to=2099-12-31`,
      `/o/${orgId}/settings/export/${shiftId}/download`,
    ]) {
      expect((await other.request.get(path)).status(), `${path} for another business`).toBe(404);
    }

    // Its own books are empty, whatever dates it asks for, and it cannot name our org in an rpc.
    await other.goto(`/o/${otherOrg}/reports/vat?from=2020-01-01&to=2099-12-31`);
    await expect(other.getByText("No sales in these dates")).toBeVisible();
    await other.goto(`/o/${otherOrg}/reports/vat?from=2020-01-01&to=2020-12-31`);
    await expect(other.getByText("No sales in these dates")).toBeVisible();
    const leaked =
      await sql`select count(*)::int as n from daily_sales_summary where org_id = ${otherOrg}`;
    expect(Number(leaked[0]!.n)).toBe(0);
  } finally {
    await ctx.close();
  }
}

/** Runs the summary job's work now (the job itself runs every few minutes). */
export const rebuildSummaries = (sql: Sql) => sql`select ops.rebuild_dirty_summaries(1000, 0)`;
