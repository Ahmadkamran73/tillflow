import { once } from "node:events";
import { createDeflateRaw } from "node:zlib";
import { csvRow } from "@/lib/csv";

/** Every table a shop's owner gets back, in this order. One CSV file each. */
export const ACCOUNT_TABLES = [
  "locations",
  "registers",
  "memberships",
  "tender_types",
  "categories",
  "products",
  "variants",
  "variant_costs",
  "customers",
  "suppliers",
  "sales",
  "sale_lines",
  "payments",
  "refunds",
  "refund_lines",
  "refund_payments",
  "stock_movements",
  "shifts",
  "shift_closes",
  "cash_movements",
] as const;

const PAGE = 5000;
/** The database refuses a stored file above 150 MB, so stop building before that. */
export const MAX_ZIP_BYTES = 150 * 1024 * 1024;

/** Text read from the database is held in memory while a table is built; stop long before that hurts. */
export const MAX_RAW_BYTES = 600 * 1024 * 1024;

export class ExportTooLarge extends Error {}

type Part = { name: Buffer; data: Buffer; crc: number; rawSize: number };

/** A zip of deflated entries: fixed timestamps, ASCII names, no extras, comments or zip64. */
function writeDeflatedZip(parts: Part[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const p of parts) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are plain ASCII; flag kept for tools that expect UTF-8
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0x21, 12); // 1980-01-01
    local.writeUInt32LE(p.crc, 14);
    local.writeUInt32LE(p.data.length, 18);
    local.writeUInt32LE(p.rawSize, 22);
    local.writeUInt16LE(p.name.length, 26);
    chunks.push(local, p.name, p.data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(p.crc, 16);
    c.writeUInt32LE(p.data.length, 20);
    c.writeUInt32LE(p.rawSize, 24);
    c.writeUInt16LE(p.name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, p.name);
    offset += local.length + p.name.length + p.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, dir, end]);
}

type Page = (table: string, offset: number, limit: number) => Promise<Record<string, unknown>[]>;

/** A JSON value as one CSV cell: objects and arrays as JSON, text made formula-safe by csvRow. */
const cell = (v: unknown): string | number =>
  v === null || v === undefined
    ? ""
    : typeof v === "number"
      ? v
      : typeof v === "string"
        ? v
        : JSON.stringify(v);

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
/** CRC-32 that can be fed in pieces: start at -1, finish with `(crc ^ -1) >>> 0`. */
function crcUpdate(crc: number, data: Uint8Array): number {
  let c = crc;
  for (let i = 0; i < data.length; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff] ?? 0) ^ (c >>> 8);
  return c;
}

/** Deflates text chunks as they arrive: only the compressed bytes are kept, never the whole text. */
async function deflateChunks(
  chunks: AsyncIterable<string>,
  state: { raw: number },
): Promise<Omit<Part, "name">> {
  const gz = createDeflateRaw({ level: 6 });
  const out: Buffer[] = [];
  gz.on("data", (b: Buffer) => out.push(b));
  const finished = new Promise<void>((resolve, reject) => {
    gz.on("end", resolve);
    gz.on("error", reject);
  });
  let crc = -1;
  let rawSize = 0;
  try {
    for await (const text of chunks) {
      const b = Buffer.from(text, "utf8");
      crc = crcUpdate(crc, b);
      rawSize += b.length;
      state.raw += b.length;
      if (state.raw > MAX_RAW_BYTES) throw new ExportTooLarge();
      if (!gz.write(b)) await once(gz, "drain");
    }
  } catch (e) {
    gz.destroy();
    throw e;
  }
  gz.end();
  await finished;
  return { data: Buffer.concat(out), crc: (crc ^ -1) >>> 0, rawSize };
}

async function* oneChunk(text: string) {
  yield text;
}

/**
 * Builds the account ZIP (one deflated CSV per table, plus README and manifest). Rows arrive a page
 * at a time from `page`; money columns stay integer cents exactly as stored. Every page goes straight
 * into the compressor, so memory holds the compressed file and one page, not the CSV text. Throws
 * ExportTooLarge rather than build a file the database would refuse (150 MB compressed).
 */
export async function buildAccountZip(
  page: Page,
  { shop, madeAt }: { shop: string; madeAt: string },
  maxBytes = MAX_ZIP_BYTES,
): Promise<Buffer> {
  const parts: Part[] = [];
  const counts: Record<string, number> = {};
  const state = { raw: 0 };
  let total = 0;
  const keep = (name: string, done: Omit<Part, "name">) => {
    total += done.data.length;
    if (total > maxBytes) throw new ExportTooLarge();
    parts.push({ name: Buffer.from(name, "ascii"), ...done });
  };

  for (const table of ACCOUNT_TABLES) {
    let n = 0;
    async function* csv() {
      let columns: string[] | null = null;
      for (let offset = 0; ; offset += PAGE) {
        const rows = await page(table, offset, PAGE);
        if (offset === 0) {
          columns = Object.keys(rows[0] ?? { "(no rows)": 0 });
          yield `﻿${csvRow(columns)}\r\n`;
        }
        if (rows.length) {
          const cols = columns!;
          yield rows.map((r) => csvRow(cols.map((c) => cell(r[c])))).join("\r\n") + "\r\n";
          n += rows.length;
        }
        if (rows.length < PAGE) break;
      }
    }
    keep(`${table}.csv`, await deflateChunks(csv(), state));
    counts[table] = n;
  }

  const readme = [
    `Tillflow data export for ${shop}`,
    `Made ${madeAt}.`,
    "",
    "One CSV file per table. Amounts are whole cents (1230 = 12.30). VAT rates are basis points (2300 = 23%).",
    "Times are UTC. Text is UTF-8. Cells that start with = + - or @ have a leading apostrophe added.",
    "Staff PIN hashes and till device tokens are not included.",
    "Keep this file safe: it holds your customers' details.",
  ].join("\r\n");
  keep("README.txt", await deflateChunks(oneChunk(readme), state));
  keep(
    "manifest.json",
    await deflateChunks(oneChunk(JSON.stringify({ shop, madeAt, rows: counts }, null, 2)), state),
  );
  return writeDeflatedZip(parts);
}
