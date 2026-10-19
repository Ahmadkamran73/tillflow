import { expect, test } from "@playwright/test";
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { openDashboard, signUpAndEnrol, uniqueEmail } from "./helpers";

// Needs the local Supabase stack and .env.local. playwright.config.ts allowlists 203.0.113.10 for
// /superadmin; the tests present an address with the X-Real-IP header, the way the host's proxy does.

config({ path: ".env.local", quiet: true });
const sql = postgres(process.env.DIRECT_URL ?? "", { max: 2, onnotice: () => {} });
test.afterAll(() => sql.end());
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1024, height: 768 } });
test.setTimeout(240_000);

const ALLOWED = "203.0.113.10";
const OTHER = "198.51.100.7";

const PATHS = (orgId: string) => [
  "/superadmin",
  "/superadmin/billing",
  `/superadmin/orgs/${orgId}`,
  `/superadmin/orgs/${orgId}/view/dashboard`,
  `/superadmin/orgs/${orgId}/view/sales`,
  `/superadmin/orgs/${orgId}/view/products`,
  `/superadmin/orgs/${orgId}/view/staff`,
  `/superadmin/orgs/${orgId}/view/shifts`,
];

test("a normal business owner (two-step, on the allowlisted address) gets 404 from every /superadmin page and action", async ({
  page,
}) => {
  await signUpAndEnrol(page, uniqueEmail("sa-normal"), "E2E superadmin normal");
  const orgId = await openDashboard(page);
  await page.setExtraHTTPHeaders({ "x-real-ip": ALLOWED });

  for (const path of PATHS(orgId)) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(404);
    // Nothing of the console leaks into the 404.
    await expect(page.getByText("Extend trial")).toHaveCount(0);
    await expect(page.getByText("Read-only view")).toHaveCount(0);
  }
  // A forged action POST is refused too.
  const post = await page.request.post(`/superadmin/orgs/${orgId}`, {
    form: { orgId, note: "pause me please", days: "7" },
    headers: { "next-action": "00".repeat(20) },
  });
  expect(post.status()).toBe(404);
  // The old path is gone.
  expect((await page.goto("/admin/billing"))?.status()).toBe(404);

  const [row] = await sql`select count(*)::int as n from audit_log
                           where org_id = ${orgId} and action like 'superadmin.%'`;
  expect(row!.n).toBe(0);
});

test("the superadmin is locked out from any other address, and from /superadmin entirely when the allowlist does not match", async ({
  page,
}) => {
  const email = uniqueEmail("sa-ip");
  await signUpAndEnrol(page, email, "E2E superadmin ip");
  const orgId = await openDashboard(page);
  const [user] = await sql`select id from auth.users where email = ${email}`;
  await sql`insert into platform_admins (user_id) values (${user!.id})`;

  for (const ip of [OTHER, "", "203.0.113.11"]) {
    await page.setExtraHTTPHeaders(ip ? { "x-real-ip": ip } : {});
    for (const path of PATHS(orgId)) {
      expect((await page.goto(path))?.status(), `${path} from ${ip || "no address"}`).toBe(404);
    }
  }
  // A spoofed first X-Forwarded-For entry does not help: the last entry is the real caller.
  await page.setExtraHTTPHeaders({ "x-forwarded-for": `${ALLOWED}, ${OTHER}` });
  expect((await page.goto("/superadmin"))?.status()).toBe(404);
});

test("the superadmin sees businesses, usage and read-only views, and extend/pause/unpause are audited", async ({
  page,
}) => {
  const email = uniqueEmail("sa-admin");
  const bizName = `E2E Zebra ${Date.now()}`;
  await signUpAndEnrol(page, email, bizName);
  const orgId = await openDashboard(page);
  await sql`insert into subscriptions (id, org_id, status, price_cents)
            values (${randomUUID()}, ${orgId}, 'trial', 4900) on conflict (org_id) do nothing`;
  const [user] = await sql`select id from auth.users where email = ${email}`;
  await sql`insert into platform_admins (user_id) values (${user!.id})`;
  await page.setExtraHTTPHeaders({ "x-real-ip": ALLOWED });

  // Business list.
  await page.goto(`/superadmin?q=${encodeURIComponent(bizName)}`);
  await expect(page.getByRole("heading", { name: "Businesses", level: 1 })).toBeVisible();
  const row = page.getByRole("row").filter({ hasText: bizName });
  await expect(row).toContainText("Trial");
  await row.getByRole("link", { name: bizName }).click();

  // Usage and actions.
  await expect(page.getByRole("heading", { name: "Usage" })).toBeVisible();
  await expect(page.getByText("Sales, last 30 days")).toBeVisible();

  const before = await sql`select trial_ends_at from organisations where id = ${orgId}`;
  await page.getByText("Extend trial", { exact: true }).first().click();
  await page.getByLabel("Days to add").fill("10");
  await page.getByLabel("Reason (kept in the audit log)").first().fill("owner asked for more time");
  await page.getByRole("button", { name: "Extend the trial" }).click();
  await expect(page.getByText("Trial extended.")).toBeVisible();
  const after = await sql`select trial_ends_at from organisations where id = ${orgId}`;
  expect(new Date(after[0]!.trial_ends_at).getTime()).toBeGreaterThan(
    new Date(before[0]!.trial_ends_at).getTime(),
  );

  await page.getByText("Pause (read-only)").click();
  await page.getByLabel("Reason (kept in the audit log)").last().fill("unpaid, called the owner");
  await page.getByRole("button", { name: "Pause this business" }).click();
  await expect(page.getByText("Business paused.")).toBeVisible();
  expect((await sql`select status from organisations where id = ${orgId}`)[0]!.status).toBe(
    "read_only",
  );

  await page.getByText("Unpause", { exact: true }).click();
  await page.getByLabel("Reason (kept in the audit log)").last().fill("paid by phone");
  await page.getByRole("button", { name: "Unpause this business" }).click();
  await expect(page.getByText("Business unpaused.")).toBeVisible();

  // Read-only views: banner on every one, and no form or submit control anywhere.
  await page.getByRole("link", { name: "View as owner (read-only)" }).last().click();
  for (const name of ["Dashboard", "Sales", "Products", "Staff", "Shifts"]) {
    await page
      .getByRole("navigation", { name: "Read-only views" })
      .getByRole("link", { name })
      .click();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    await expect(page.getByRole("note")).toContainText(`Viewing ${bizName} read-only`);
    await expect(page.locator("form")).toHaveCount(0);
    await expect(page.locator("main button, main input[type=submit], main [role=button]")).toHaveCount(0);
  }
  await page.getByRole("link", { name: "Exit read-only view" }).click();
  await expect(page.getByRole("heading", { name: bizName, level: 1 })).toBeVisible();

  // Everything is in that business's audit log, attributed to the admin.
  const log = await sql`select action, actor_user_id from audit_log
                         where org_id = ${orgId} and action like 'superadmin.%' or
                               (org_id = ${orgId} and action = 'billing.unpaused')`;
  const actions = log.map((r) => r.action);
  expect(actions).toEqual(
    expect.arrayContaining([
      "superadmin.trial_extended",
      "superadmin.paused",
      "billing.unpaused",
      "superadmin.viewed",
    ]),
  );
  expect(log.every((r) => r.actor_user_id === user!.id)).toBe(true);
  expect(actions.filter((a) => a === "superadmin.viewed").length).toBeGreaterThanOrEqual(6);
});
