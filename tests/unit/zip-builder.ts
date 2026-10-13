import { deflateRawSync } from "node:zlib";
import { crc32 } from "@/lib/import/xlsx-zip.mjs";

/**
 * Hand-built zips for adversarial tests. Every header field can be made to lie, so one line per
 * attack. Not a general zip library: no extras, no zip64 records, no encryption.
 */
export type Entry = {
  name: string | Buffer;
  /** Uncompressed content. Default: empty. */
  data?: Buffer;
  /** 0 stored, 8 deflate. Default 8 (0 when `data` is empty and `dir`). */
  method?: number;
  flags?: number;
  /** Lies in the central header. */
  crc?: number;
  size?: number;
  compressedSize?: number;
  /** A different name in the local header than in the central one. */
  localName?: string | Buffer;
  /** Bytes to store as the compressed data, instead of compressing `data`. */
  raw?: Buffer;
  /** Make the central header point at the local header of entry number `n` (overlap). */
  pointAt?: number;
  /** Make the central header point at the DATA of entry number `n` (a header hidden inside it). */
  pointAtData?: number;
  /** Add this many bytes of local-header extra field. */
  localExtra?: number;
};

export type Options = {
  declared?: number;
  prefix?: number;
  diskNo?: number;
  diskCd?: number;
  onDisk?: number;
  /** Bytes between the last local entry and the central directory. */
  gap?: number;
  comment?: Buffer;
};

const buf = (v: string | Buffer) => (typeof v === "string" ? Buffer.from(v, "utf8") : v);

export function buildZip(entries: Entry[], o: Options = {}): Buffer {
  const chunks: Buffer[] = [Buffer.alloc(o.prefix ?? 0, 0x41)];
  const offsets: number[] = [];
  const dataStarts: number[] = [];
  const meta: {
    name: Buffer;
    method: number;
    crc: number;
    comp: number;
    size: number;
    flags: number;
  }[] = [];
  let offset = o.prefix ?? 0;
  for (const e of entries) {
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 8;
    const compressed = e.raw ?? (method === 8 ? deflateRawSync(data) : data);
    const name = buf(e.name);
    const localName = e.localName === undefined ? name : buf(e.localName);
    const extra = Buffer.alloc(e.localExtra ?? 0, 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    local.writeUInt16LE(extra.length, 28);
    chunks.push(local, localName, extra, compressed);
    offsets.push(offset);
    dataStarts.push(offset + local.length + localName.length + extra.length);
    meta.push({
      name,
      method,
      crc: e.crc ?? crc32(data),
      comp: e.compressedSize ?? compressed.length,
      size: e.size ?? data.length,
      flags: e.flags ?? 0,
    });
    offset += local.length + localName.length + extra.length + compressed.length;
  }
  if (o.gap) {
    chunks.push(Buffer.alloc(o.gap, 0));
    offset += o.gap;
  }
  const dirStart = offset;
  const central: Buffer[] = [];
  meta.forEach((m, i) => {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(m.flags, 8);
    c.writeUInt16LE(m.method, 10);
    c.writeUInt32LE(m.crc, 16);
    c.writeUInt32LE(m.comp, 20);
    c.writeUInt32LE(m.size, 24);
    c.writeUInt16LE(m.name.length, 28);
    const target = entries[i]?.pointAt;
    const hidden = entries[i]?.pointAtData;
    const where =
      hidden !== undefined ? (dataStarts[hidden] ?? 0) : target !== undefined ? (offsets[target] ?? 0) : (offsets[i] ?? 0);
    c.writeUInt32LE(where, 42);
    central.push(c, m.name);
  });
  const dir = Buffer.concat(central);
  const comment = o.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(o.diskNo ?? 0, 4);
  end.writeUInt16LE(o.diskCd ?? 0, 6);
  end.writeUInt16LE(o.onDisk ?? o.declared ?? entries.length, 8);
  end.writeUInt16LE(o.declared ?? entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(dirStart, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...chunks, dir, end, comment]);
}

const xml = (s: string) => Buffer.from(s, "utf8");

/** The two parts every xlsx needs, so a test only adds what it is about. */
export const BASE: Entry[] = [
  { name: "[Content_Types].xml", data: xml("<Types/>") },
  { name: "xl/workbook.xml", data: xml("<workbook/>") },
];

/** Names of the entries of a zip, read from its central directory (test helper, trusting). */
export function listNames(zip: Buffer): string[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(eocd + 16);
  const out: string[] = [];
  while (zip.readUInt32LE(at) === 0x02014b50) {
    const n = zip.readUInt16LE(at + 28);
    out.push(zip.subarray(at + 46, at + 46 + n).toString("utf8"));
    at += 46 + n + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}

/** Compression method of every entry in a zip (test helper). */
export function listMethods(zip: Buffer): number[] {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(eocd + 16);
  const out: number[] = [];
  while (zip.readUInt32LE(at) === 0x02014b50) {
    out.push(zip.readUInt16LE(at + 10));
    at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return out;
}
