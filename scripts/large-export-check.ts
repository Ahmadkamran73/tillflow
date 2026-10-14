/**
 * Seeds a realistic large shop and runs the whole-account export on it the way the background job
 * does (ops.account_export_rows pages -> buildAccountZip -> ops.account_export_finish), then checks
 * the file. Prints rows, ZIP size, time and peak memory as JSON.
 *
 * LOCAL OR STAGING ONLY: it writes thousands of append-only sales that cannot be deleted. It refuses
 * a non-local database unless --allow-remote is given, and never use the production project.
 *
 *   pnpm exec tsx scripts/large-export-check.ts [--sales 100000] [--org <uuid> [--no-seed]] [--url-env DIRECT_URL] [--allow-remote]
 *
 * Without --org it creates its own shop. With --org it adds the data to that shop's first location
 * and till, so an owner of that shop can then request the export in the app (Settings > Export all my
 * data) and you can watch the real job on the host. See docs/specs/reports.md, "Large export".
 */
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { inflateRawSync } from "node:zlib";
import { ACCOUNT_TABLES, buildAccountZip } from "../src/lib/export/account-zip";
import { crc32 } from "../src/lib/import/xlsx-zip.mjs";

config({ path: ".env.local", quiet: true });

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const urlEnv = arg("url-env") ?? "DIRECT_URL";
const url = process.env[urlEnv];
if (!url) {
  console.error(`${urlEnv} is not set`);
  process.exit(1);
}
const host = new URL(url).hostname;
if (!["localhost", "127.0.0.1", "::1"].includes(host) && !flag("allow-remote")) {
  console.error(`Refusing ${host}: not a local database. Use --allow-remote only for staging.`);
  process.exit(1);
}
const SALES = Number(arg("sales") ?? 100_000);
if (!Number.isInteger(SALES) || SALES < 1 || SALES > 2_000_000) throw new Error("bad --sales");

const sql = postgres(url, { max: 2, onnotice: () => {}, idle_timeout: 20 });
const mb = (n: number) => Math.round((n / 1_048_576) * 10) / 10;

async function seed(): Promise<{ org: string; seeded: number }> {
  let org = arg("org");
  if (!org) {
    org = randomUUID();
    const loc = randomUUID();
    await sql`insert into organisations (id, name, business_type) values (${org}, ${"Large export test " + Date.now()}, 'general')`;
    await sql`insert into locations (id, org_id, name) values (${loc}, ${org}, 'Main')`;
    await sql`insert into registers (id, org_id, location_id, name, device_token_hash)
              values (${randomUUID()}, ${org}, ${loc}, 'Till 1', ${randomUUID().replace(/-/g, "").padEnd(64, "0")})`;
  }
  const [loc] =
    await sql`select id from locations where org_id = ${org} order by created_at limit 1`;
  const [reg] =
    await sql`select id from registers where org_id = ${org} order by created_at limit 1`;
  if (!loc || !reg) throw new Error("that shop has no location or till");
  const next = Number(
    (
      await sql`select coalesce(max(receipt_seq), 0) + 1 as next from sales where org_id = ${org} and register_id = ${reg.id}`
    )[0]!.next,
  );
  const user = randomUUID();
  const tag = randomUUID().slice(0, 8);
  console.error(
    `seeding ${SALES} sales (+3 lines, 1 payment each), 20k products, 20k customers ...`,
  );

  await sql`insert into products (id, org_id, name, tax_category)
            select md5(${tag} || 'p' || g)::uuid, ${org}, 'Product ' || g, 'STANDARD' from generate_series(1, 20000) g`;
  await sql`insert into variants (id, org_id, product_id, price_incl_vat_cents)
            select md5(${tag} || 'v' || g)::uuid, ${org}, md5(${tag} || 'p' || g)::uuid, 410 from generate_series(1, 20000) g`;
  await sql`insert into customers (id, org_id, name, email, phone)
            select md5(${tag} || 'c' || g)::uuid, ${org}, 'Customer ' || g, 'c' || g || '@example.com', '+35387' || lpad(g::text, 7, '0')
              from generate_series(1, 20000) g`;
  await sql`insert into stock_movements (id, org_id, variant_id, location_id, qty_delta, reason)
            select md5(${tag} || 'm' || g)::uuid, ${org}, md5(${tag} || 'v' || (1 + g % 20000))::uuid, ${loc.id}, 1, 'adjustment'
              from generate_series(1, ${Math.min(SALES, 20_000)}::int) g`;

  for (let from = 1; from <= SALES; from += 25_000) {
    const to = Math.min(SALES, from + 24_999);
    await sql.begin(async (tx) => {
      await tx`insert into sales (id, org_id, register_id, location_id, receipt_seq, mode, completed_at, received_at, priced_as_of,
                                  cashier_user_id, items_total_cents, vat_cents, non_vat_cents, cash_rounding_cents, amount_due_cents, client_due_cents)
               select md5(${tag} || 's' || g)::uuid, ${org}, ${reg.id}, ${loc.id}, ${next}::int + g, 'eat_in',
                      now() - (g % 80) * interval '1 day' - (g % 1440) * interval '1 minute', now(),
                      now() - (g % 80) * interval '1 day' - (g % 1440) * interval '1 minute',
                      ${user}, 1230, 231, 0, 0, 1230, 1230
                 from generate_series(${from}::int, ${to}::int) g`;
      await tx`insert into sale_lines (id, org_id, sale_id, line_no, kind, variant_id, product_id, name, qty, unit_price_cents,
                                       discount_cents, tax_category, tax_rate_bp, net_cents, vat_cents, gross_cents)
               select md5(${tag} || 'l' || g || '-' || l)::uuid, ${org}, md5(${tag} || 's' || g)::uuid, l, 'item',
                      md5(${tag} || 'v' || (1 + (g + l) % 20000))::uuid, md5(${tag} || 'p' || (1 + (g + l) % 20000))::uuid,
                      'Product ' || (1 + (g + l) % 20000), 1, 410, 0, 'STANDARD', 2300, 333, 77, 410
                 from generate_series(${from}::int, ${to}::int) g cross join generate_series(1, 3) l`;
      await tx`insert into payments (id, org_id, sale_id, method, label, amount_cents, tendered_cents, change_cents, tip_cents)
               select md5(${tag} || 'y' || g)::uuid, ${org}, md5(${tag} || 's' || g)::uuid, 'cash', 'Cash', 1230, 1230, 0, 0
                 from generate_series(${from}::int, ${to}::int) g`;
    });
    console.error(`  sales ${to}/${SALES}`);
  }
  return { org, seeded: SALES };
}

/** Reads a stored zip: every entry's CRC against its header and its content as text. */
function checkZip(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let p = zip.readUInt32LE(end + 16);
  const lines: Record<string, number> = {};
  let bad = 0;
  for (let i = 0; i < count; i++) {
    const crc = zip.readUInt32LE(p + 16);
    const size = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const local = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("ascii");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const method = zip.readUInt16LE(p + 10);
    const stored = zip.subarray(start, start + size);
    const data = method === 8 ? inflateRawSync(stored) : stored;
    if (crc32(data) !== crc) bad++;
    if (name.endsWith(".csv")) {
      let n = 0;
      for (const b of data) if (b === 0x0a) n++;
      lines[name.replace(".csv", "")] = n; // rows + header (cells with line breaks are quoted: counted below)
    }
    p += 46 + nameLen;
  }
  return { entries: count, badCrc: bad, lines };
}

async function main() {
  const t0 = Date.now();
  const { org } = flag("no-seed") && arg("org") ? { org: arg("org")! } : await seed();
  console.error(`seeded in ${Math.round((Date.now() - t0) / 1000)}s; exporting ...`);

  const exportId = randomUUID();
  await sql`insert into account_exports (id, org_id, requested_by, status) values (${exportId}, ${org}, ${randomUUID()}, 'running')`;

  let peak = 0;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 100);
  const t1 = Date.now();
  const zip = await buildAccountZip(
    async (table, offset, limit) => {
      if (offset === 0) console.error(`  reading ${table} ...`);
      const rows = (
        await sql`select ops.account_export_rows(${exportId}, ${table}, ${offset}, ${limit}) as r`
      )[0]!.r;
      return rows as Record<string, unknown>[];
    },
    { shop: "Large export test", madeAt: new Date().toISOString() },
  );
  const buildSeconds = (Date.now() - t1) / 1000;
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage().rss);

  const t2 = Date.now();
  await sql`select ops.account_export_finish(${exportId}, 'large.zip', ${zip})`;
  const storeSeconds = (Date.now() - t2) / 1000;
  const n = (
    await sql`select octet_length(bytes) as n from account_export_files where export_id = ${exportId}`
  )[0]!.n;

  const check = checkZip(zip);
  const counts: Record<string, number> = {};
  for (const table of ACCOUNT_TABLES) {
    const rows = await sql.unsafe(
      `select count(*)::int as c from public.${table} where org_id = '${org}'`,
    );
    counts[table] = Number(rows[0]!.c);
  }
  const mismatches = ACCOUNT_TABLES.filter(
    (t) => (check.lines[t] ?? 0) < counts[t]! + 1 && counts[t]! > 0,
  );

  console.log(
    JSON.stringify(
      {
        org,
        exportId,
        dbRows: counts,
        zipMB: mb(zip.length),
        storedBytesMatch: Number(n) === zip.length,
        entries: check.entries,
        badCrc: check.badCrc,
        csvLinesLessThanRows: mismatches,
        buildSeconds,
        storeSeconds,
        peakRssMB: mb(peak),
        heapUsedMB: mb(process.memoryUsage().heapUsed),
        note: "a CSV line count below rows+1 means rows are missing; extra lines are quoted line breaks",
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
