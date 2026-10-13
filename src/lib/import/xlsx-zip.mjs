// Plain ES module on purpose: the app imports it, and the sandboxed xlsx parser (Layer 2) runs the
// very same file in a separate Node process that has no TypeScript or bundler.
import { inflateRawSync } from "node:zlib";

/**
 * Canonical .xlsx: ExcelJS must never receive the bytes a user uploaded.
 *
 * ExcelJS reads zips with JSZip, which interprets a zip differently from other readers (it reads
 * headers until the signature stops matching, shifts offsets for prefix bytes, switches to zip64 on
 * a maximum value in several fields...). Every special case in a guard written beside it is a place
 * where the guard and JSZip can disagree. So instead of predicting what JSZip will see, this module
 * reads the upload ONCE with strict rules, keeps only the parts a spreadsheet needs (each inflated
 * under a hard cap and checked against its CRC and size), and writes a brand new zip of its own.
 * ExcelJS only ever reads that zip: its structure is ours, whatever the upload looked like.
 */

export const XLSX_LIMITS = {
  /** Entries in the uploaded archive (kept or not). */
  entries: 200,
  /** Inflated bytes of all kept parts together. */
  totalBytes: 64 * 1024 * 1024,
  /**
   * Inflated bytes of one worksheet or of the shared strings. ExcelJS turns XML into objects at
   * many times the size, so this is kept near what a real 50,000-row product sheet needs (about
   * 35 bytes per cell). A larger sheet is refused as too big: split the file.
   */
  bigPartBytes: 32 * 1024 * 1024,
  stylesBytes: 8 * 1024 * 1024,
  smallPartBytes: 4 * 1024 * 1024,
  nameLength: 255,
};

/** A refusal. `code` is "unreadable" (not a clean xlsx) or "size" (over a cap). */
export class XlsxZipError extends Error {
  /** @param {"unreadable" | "size"} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const bad = () => new XlsxZipError("unreadable");
const tooBig = () => new XlsxZipError("size");

const EXACT = new Map([
  ["[Content_Types].xml", XLSX_LIMITS.smallPartBytes],
  ["_rels/.rels", XLSX_LIMITS.smallPartBytes],
  ["xl/workbook.xml", XLSX_LIMITS.smallPartBytes],
  ["xl/_rels/workbook.xml.rels", XLSX_LIMITS.smallPartBytes],
  ["xl/styles.xml", XLSX_LIMITS.stylesBytes],
  ["xl/sharedStrings.xml", XLSX_LIMITS.bigPartBytes],
  ["docProps/core.xml", XLSX_LIMITS.smallPartBytes],
  ["docProps/app.xml", XLSX_LIMITS.smallPartBytes],
]);
// The other parts a sheet can refer to. ExcelJS fails when a sheet names a relationship target that
// is missing (hyperlinks, drawings, tables, comments), so those XML parts are kept, each under a
// small cap. The patterns are exactly the names ExcelJS itself loads (lib/xlsx/xlsx.js), so nothing
// it would ignore is kept: a worksheet named anything but sheetN.xml is dropped. Images (xl/media),
// macros, embedded files, external links, custom XML, printer settings and anything else are
// dropped as well; ExcelJS skips a missing image.
const SMALL_PATTERNS = [
  /^xl\/theme\/[A-Za-z0-9]{1,64}\.xml$/,
  /^xl\/worksheets\/_rels\/sheet[0-9]{1,4}\.xml\.rels$/,
  /^xl\/drawings\/[A-Za-z0-9]{1,64}\.xml$/,
  /^xl\/drawings\/vmlDrawing[0-9]{1,4}\.vml$/,
  /^xl\/drawings\/_rels\/[A-Za-z0-9]{1,64}\.xml\.rels$/,
  /^xl\/tables\/table[0-9]{1,4}\.xml$/,
  /^xl\/comments[0-9]{1,4}\.xml$/,
];
const SHEET = /^xl\/worksheets\/sheet[0-9]{1,4}\.xml$/;

/**
 * The inflated-size cap for a part we keep, or null for a part we drop (images, drawings, comments,
 * tables, macros, embedded files, custom XML, external links, sheet relationships...).
 * @param {string} name
 */
export function partCap(name) {
  const exact = EXACT.get(name);
  if (exact !== undefined) return exact;
  if (SHEET.test(name)) return XLSX_LIMITS.bigPartBytes;
  if (SMALL_PATTERNS.some((re) => re.test(name))) return XLSX_LIMITS.smallPartBytes;
  return null;
}

// CRC-32 (IEEE), table driven, so this does not depend on the Node version having zlib.crc32.
const TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c;
}
/** @param {Uint8Array} data */
export function crc32(data) {
  let c = -1;
  for (let i = 0; i < data.length; i++) c = (TABLE[(c ^ data[i]) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A safe, plain entry name or throws. Directories (trailing "/") come back with `dir: true`. */
function cleanName(raw) {
  let name;
  try {
    name = utf8.decode(raw);
  } catch {
    throw bad();
  }
  if (name.length === 0 || name.length > XLSX_LIMITS.nameLength) throw bad();
  if (/[\\\u0000-\u001f\u007f]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name))
    throw bad();
  const dir = name.endsWith("/");
  const parts = (dir ? name.slice(0, -1) : name).split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) throw bad();
  return { name, dir };
}

/**
 * @param {Buffer} zip the uploaded bytes
 * @returns {Buffer} a new zip (stored, ASCII names, whitelisted parts only)
 */
export function canonicalXlsx(zip) {
  // ---- end record: the last signature in the final 64 KB, plain single-disk archives only
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65_535); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const declared = zip.readUInt16LE(eocd + 10);
  const dirSize = zip.readUInt32LE(eocd + 12);
  const dirStart = zip.readUInt32LE(eocd + 16);
  if (
    zip.readUInt16LE(eocd + 4) !== 0 ||
    zip.readUInt16LE(eocd + 6) !== 0 ||
    zip.readUInt16LE(eocd + 8) !== declared ||
    declared === 0 ||
    declared > XLSX_LIMITS.entries ||
    dirSize === 0xffffffff ||
    dirStart === 0xffffffff ||
    dirStart + dirSize !== eocd // no bytes between directory and end record, no prefix bytes
  ) {
    throw bad();
  }

  // ---- every central header, up to the end record (the count must match the declared one)
  /** @type {{ name: string, method: number, crc: number, compressed: number, size: number, dataStart: number }[]} */
  const kept = [];
  const seen = new Set();
  /** @type {[number, number][]} */
  const ranges = [];
  let at = dirStart;
  let count = 0;
  while (at < eocd) {
    if (++count > XLSX_LIMITS.entries) throw bad();
    if (at + 46 > eocd || zip.readUInt32LE(at) !== 0x02014b50) throw bad();
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const disk = zip.readUInt16LE(at + 34);
    const local = zip.readUInt32LE(at + 42);
    const next = at + 46 + nameLen + extraLen + commentLen;
    if (
      next > eocd ||
      disk !== 0 ||
      local === 0xffffffff ||
      compressed === 0xffffffff ||
      size === 0xffffffff
    ) {
      throw bad();
    }
    if (flags & 0x1 || flags & 0x40) throw bad(); // encrypted

    const { name, dir } = cleanName(zip.subarray(at + 46, at + 46 + nameLen));
    const key = name.toLowerCase();
    if (seen.has(key)) throw bad(); // duplicate part names: which one would a reader pick?
    seen.add(key);

    // the local header must agree with the central one
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw bad();
    const lNameLen = zip.readUInt16LE(local + 26);
    const dataStart = local + 30 + lNameLen + zip.readUInt16LE(local + 28);
    if (
      lNameLen !== nameLen ||
      !zip
        .subarray(local + 30, local + 30 + lNameLen)
        .equals(zip.subarray(at + 46, at + 46 + nameLen))
    ) {
      throw bad();
    }
    if (dataStart + compressed > dirStart) throw bad(); // data must lie before the directory
    ranges.push([local, dataStart + compressed]);

    if (!dir && partCap(name) !== null) {
      if (method !== 0 && method !== 8) throw bad();
      kept.push({ name, method, crc, compressed, size, dataStart });
    } else if (dir && (size !== 0 || compressed > 2)) {
      throw bad();
    }
    at = next;
  }
  if (at !== eocd || count !== declared) throw bad();

  // overlapping entries would let one stream be read as several parts
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++)
    if ((ranges[i]?.[0] ?? 0) < (ranges[i - 1]?.[1] ?? 0)) throw bad();

  for (const needed of ["[Content_Types].xml", "xl/workbook.xml"]) {
    if (!kept.some((p) => p.name === needed)) throw bad();
  }

  // ---- inflate the kept parts under their caps, verify size and CRC
  let total = 0;
  /** @type {{ name: Buffer, data: Buffer, crc: number }[]} */
  const parts = [];
  for (const p of kept.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const cap = partCap(p.name) ?? 0;
    const raw = zip.subarray(p.dataStart, p.dataStart + p.compressed);
    let data;
    try {
      data =
        p.method === 0
          ? Buffer.from(raw)
          : inflateRawSync(raw, {
              maxOutputLength: Math.min(cap, XLSX_LIMITS.totalBytes - total) + 1,
            });
    } catch (e) {
      if (/** @type {{ code?: string }} */ (e).code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
      throw bad();
    }
    if (data.length > cap) throw tooBig();
    total += data.length;
    if (total > XLSX_LIMITS.totalBytes) throw tooBig();
    if (data.length !== p.size || crc32(data) !== p.crc) throw bad();
    parts.push({ name: Buffer.from(p.name, "ascii"), data, crc: p.crc });
  }

  return writeStoredZip(parts);
}

/**
 * Our own zip: stored (no compression), fixed timestamps, ASCII names, no extras or comments.
 * @param {{ name: Buffer, data: Buffer, crc: number }[]} parts
 */
export function writeStoredZip(parts) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const p of parts) {
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); // time 00:00:00
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(p.crc, 14);
    local.writeUInt32LE(p.data.length, 18);
    local.writeUInt32LE(p.data.length, 22);
    local.writeUInt16LE(p.name.length, 26);
    chunks.push(local, p.name, p.data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(0, 10);
    c.writeUInt16LE(0, 12);
    c.writeUInt16LE(0x21, 14);
    c.writeUInt32LE(p.crc, 16);
    c.writeUInt32LE(p.data.length, 20);
    c.writeUInt32LE(p.data.length, 24);
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
