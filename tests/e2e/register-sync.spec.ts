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
// the test looks at the server's tables, as an administrator).
//
// The first test reloads the register while offline, which only works with the service worker, and
// that is built by `next build --webpack` and switched off in `next dev`. It therefore runs in CI
// (production build) or locally with:  pnpm build  then  CI=1 pnpm test:e2e register-sync
const hasServiceWorker = !!process.env.CI || process.env.E2E_SW === "1";

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());

test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(240_000);

async function setup(page: Page, label: string, openingStock = 50) {
  await page.addInitScript(() => {
    window.print = () => {}; // the browser-print fallback must not open a dialog
  });
  await signUpAndEnrol(page, uniqueEmail(label), `E2E sync ${label}`);
  const orgId = await openDashboard(page);
  await page.goto(`/o/${orgId}/products/new`);
  await hydrated(page);
  await page.getByLabel("Name").fill("Tea bags");
  await page.getByLabel("Price (including VAT)").fill("12.30");
  await page.getByLabel("Barcode").fill("5012345678900");
  await page.getByLabel("Opening stock").fill(String(openingStock));
  await page.getByRole("button", { name: "Save product" }).click();
  await expect(page).toHaveURL(/\/products\?saved=1$/);
  const [v] = await sql`select id from variants where org_id = ${orgId}`;
  return { orgId, variantId: v!.id as string };
}

const tile = (page: Page) => page.getByRole("button", { name: /^Tea bags/ });

/** One complete cash sale: tile, Pay, exact cash, back to a fresh sale. */
async function sell(page: Page) {
  await tile(page).click();
  await page.getByRole("button", { name: "Pay €12.30" }).first().click();
  await page.getByRole("button", { name: /^Exact/ }).click();
  await expect(page.getByRole("heading", { name: "Sale complete" })).toBeVisible();
  await page.getByRole("button", { name: "New sale" }).click();
}

const pill = (page: Page, text: string | RegExp) =>
  page.getByRole("status").filter({ hasText: text });

async function openRegister(page: Page, orgId: string) {
  await openTill(page, orgId); // PIN, pairing code, pair this browser, unlock
  await expect(tile(page)).toBeVisible();
  await expect(pill(page, /^Online$/)).toBeVisible();
}

const serverFacts = async (orgId: string, variantId: string) => {
  const [r] = await sql`
    select (select count(*) from sales where org_id = ${orgId})::int as sales,
           (select count(*) from payments where org_id = ${orgId})::int as payments,
           (select count(*) from sale_lines where org_id = ${orgId})::int as lines,
           (select count(distinct receipt_seq) from sales where org_id = ${orgId})::int as seqs,
           (select coalesce(min(amount_due_cents), 0) from sales where org_id = ${orgId})::int as min_due,
           (select coalesce(max(amount_due_cents), 0) from sales where org_id = ${orgId})::int as max_due,
           (select coalesce(sum(vat_cents), 0) from sales where org_id = ${orgId})::int as vat,
           (select coalesce(sum(on_hand), 0) from stock_levels where variant_id = ${variantId})::int as on_hand`;
  return r!;
};

/** Reads and changes the device's outbox directly (IndexedDB), as the till itself would hold it. */
const outbox = {
  all: (page: Page, orgId: string) =>
    page.evaluate(
      (org) =>
        new Promise<Record<string, unknown>[]>((resolve, reject) => {
          const open = indexedDB.open(`tillflow-${org}`);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const req = open.result.transaction("sales").objectStore("sales").getAll();
            req.onsuccess = () => {
              open.result.close();
              resolve(req.result as Record<string, unknown>[]);
            };
            req.onerror = () => reject(req.error);
          };
        }),
      orgId,
    ),
  tamper: (page: Page, orgId: string, expectedDueCents: number) =>
    page.evaluate(
      ([org, due]) =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open(`tillflow-${org}`);
          open.onsuccess = () => {
            const tx = open.result.transaction("sales", "readwrite");
            const store = tx.objectStore("sales");
            const all = store.getAll();
            all.onsuccess = () => {
              for (const row of all.result) store.put({ ...row, expectedDueCents: due });
            };
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
        }),
      [orgId, expectedDueCents] as const,
    ),
};

test("offline: 20 sales survive a reload and reach the server exactly once; a replay creates nothing", async ({
  page,
  context,
}) => {
  test.skip(
    !hasServiceWorker,
    "needs the production build (service worker): see the top of this file",
  );
  const { orgId, variantId } = await setup(page, "offline20");
  await openRegister(page, orgId);

  // Let the service worker take over, then load once more so the register page is cached.
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await unlockTill(page);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  await expect(tile(page)).toBeVisible();

  await context.setOffline(true);
  for (let i = 0; i < 20; i++) await sell(page);
  await expect(pill(page, "Offline (20 waiting)")).toBeVisible();
  expect((await serverFacts(orgId, variantId)).sales).toBe(0); // nothing has reached the server

  // A reload while offline: the page still loads and still knows about all 20 sales.
  await page.reload();
  await unlockTill(page); // offline: the PIN is checked against the hash saved on the till
  await expect(tile(page)).toBeVisible();
  await expect(pill(page, "Offline (20 waiting)")).toBeVisible();

  await context.setOffline(false);
  await expect(pill(page, /^Online$/)).toBeVisible({ timeout: 60_000 });

  const facts = await serverFacts(orgId, variantId);
  expect(facts).toMatchObject({
    sales: 20,
    payments: 20,
    lines: 20,
    seqs: 20,
    min_due: 1230,
    max_due: 1230,
    vat: 20 * 230,
    on_hand: 30,
  });
  expect((await outbox.all(page, orgId)).every((s) => s.syncState === "synced")).toBe(true);

  // Replay every sale the till holds: the server answers "duplicate" and writes nothing.
  const replay = await page.evaluate(
    async ([org, sales]) => {
      type Row = {
        id: string;
        registerId: string;
        receiptSeq: number;
        completedAt: string;
        tenderedCents: number;
        expectedDueCents: number;
        cart: { lines: { variantId: string; qty: number }[] };
      };
      const rows = sales as unknown as Row[];
      const registerId = rows[0]!.registerId;
      const wire = rows.map((s) => ({
        id: s.id,
        receiptSeq: s.receiptSeq,
        completedAt: s.completedAt,
        mode: "eat_in",
        lines: s.cart.lines.map((l) => ({
          variantId: l.variantId,
          qty: l.qty,
          modifierIds: [],
        })),
        tenderedCents: s.tenderedCents,
        expectedDueCents: s.expectedDueCents,
      }));
      const out: string[] = [];
      for (let i = 0; i < wire.length; i += 10) {
        const res = await fetch(`/api/v1/sync/sales?orgId=${org}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ registerId, sales: wire.slice(i, i + 10) }),
        });
        const body = (await res.json()) as { results: { status: string }[] };
        out.push(...body.results.map((r) => r.status));
      }
      return out;
    },
    [orgId, await outbox.all(page, orgId)] as const,
  );
  expect(replay).toHaveLength(20);
  expect(new Set(replay)).toEqual(new Set(["duplicate"]));
  expect(await serverFacts(orgId, variantId)).toEqual(facts);
});

test("a price changed while the till was offline does not reject the sale", async ({
  page,
  context,
}) => {
  const { orgId, variantId } = await setup(page, "pricechange");
  await openRegister(page, orgId);

  await context.setOffline(true);
  await sell(page);
  await expect(pill(page, "Offline (1 waiting)")).toBeVisible();

  // A manager raises the price while the till cannot hear about it.
  await sql`update variants set price_incl_vat_cents = 1500 where id = ${variantId}`;

  await context.setOffline(false);
  await expect(pill(page, /^Online$/)).toBeVisible({ timeout: 60_000 });
  const facts = await serverFacts(orgId, variantId);
  expect(facts).toMatchObject({ sales: 1, min_due: 1230, max_due: 1230, on_hand: 49 });
});

test("a sale the server refuses lands in Needs attention and can be resolved with a note", async ({
  page,
  context,
}) => {
  const { orgId, variantId } = await setup(page, "attention");
  await openRegister(page, orgId);

  await context.setOffline(true);
  await sell(page);
  await outbox.tamper(page, orgId, 9999); // the till "charged" €99.99; the server says €12.30
  await context.setOffline(false);

  await expect(page.getByText(/1 sale\(s\) were not accepted/)).toBeVisible({ timeout: 60_000 });
  expect((await serverFacts(orgId, variantId)).sales).toBe(0);
  expect((await outbox.all(page, orgId))[0]).toMatchObject({
    syncState: "rejected",
    rejectReason: "price_mismatch",
  });

  await page.goto(`/o/${orgId}/sales/attention`);
  await expect(
    page.getByText("The total on the till differs from the server's total."),
  ).toBeVisible();
  await expect(page.getByText("Till: €99.99")).toBeVisible();
  await expect(page.getByText("Server: €12.30")).toBeVisible();
  await expect(page.getByText("1 × Tea bags")).toBeVisible();

  // Trying again cannot make a wrong total right: the server still refuses it.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("The server still did not accept this sale.")).toBeVisible();
  expect((await serverFacts(orgId, variantId)).sales).toBe(0);

  await page.getByRole("button", { name: "Mark resolved" }).click(); // needs a note
  await page.getByLabel("Note (what you did)").fill("Customer paid €12.30; typo on the till");
  await page.getByRole("button", { name: "Mark resolved" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Marked as resolved." })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Nothing needs attention" })).toBeVisible();
  const audit = await sql`select action from audit_log where org_id = ${orgId}
                          and action in ('sale.sync_rejected', 'sale.sync_rejection_resolved')`;
  expect(audit.map((r) => r.action).sort()).toEqual([
    "sale.sync_rejected",
    "sale.sync_rejection_resolved",
  ]);
});

test("sync refuses an unpaired caller, a till of another shop and a different till", async ({
  page,
  request,
}) => {
  const { orgId } = await setup(page, "syncauth");
  const call = (api: typeof request, org: string, registerId: string) =>
    api.post(`/api/v1/sync/sales?orgId=${org}`, {
      data: { registerId, sales: [] },
      maxRedirects: 0,
    });
  const someTill = "00000000-0000-4000-8000-0000000000e1";
  // The back-office session alone is not a till: 401 (no device token), never a redirect.
  expect((await call(page.request, orgId, someTill)).status()).toBe(401);
  expect((await call(request, orgId, someTill)).status()).toBe(401);

  // Pair this browser as Till 1; now it is a till, but only for its own shop and its own register.
  await openTill(page, orgId);
  expect((await call(page.request, "00000000-0000-4000-8000-000000000000", someTill)).status()).toBe(
    404,
  );
  expect((await call(page.request, orgId, someTill)).status()).toBe(403);
  const [reg] = await sql`select id from registers where org_id = ${orgId}`;
  expect((await call(page.request, orgId, reg!.id)).status()).toBe(200);
  // A fresh context has neither session nor token.
  expect((await call(request, orgId, reg!.id)).status()).toBe(401);
});
