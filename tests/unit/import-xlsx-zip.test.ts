// @vitest-environment node
import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";
import { ImportFileError, parseUpload } from "@/lib/import/parse";
import {
  canonicalXlsx,
  crc32,
  partCap,
  XLSX_LIMITS,
  XlsxZipError,
} from "@/lib/import/xlsx-zip.mjs";
import { BASE, buildZip, listMethods, listNames, type Entry } from "./zip-builder";

const MB = 1024 * 1024;
const bytes = (s: string) => Buffer.from(s, "utf8");

/** The error code canonicalXlsx throws, or null when it accepts. */
function code(zip: Buffer): string | null {
  try {
    canonicalXlsx(zip);
    return null;
  } catch (e) {
    if (e instanceof XlsxZipError) return e.code;
    throw e;
  }
}
const withBase = (...extra: Entry[]) => buildZip([...BASE, ...extra]);

describe("canonicalXlsx: what it keeps and what it writes", () => {
  it("keeps only whitelisted parts, drops the rest without inflating them, and writes a stored zip", () => {
    const zip = withBase(
      { name: "xl/worksheets/sheet1.xml", data: bytes("<worksheet/>") },
      { name: "xl/sharedStrings.xml", data: bytes("<sst/>") },
      { name: "xl/media/image1.png", data: bytes("png") },
      { name: "xl/vbaProject.bin", data: bytes("macro") },
      { name: "customXml/item1.xml", data: bytes("<x/>") },
      // garbage that is not even valid deflate: it is dropped, so it is never read
      {
        name: "xl/embeddings/bomb.bin",
        method: 8,
        raw: Buffer.from([1, 2, 3, 4]),
        size: 99,
        crc: 1,
      },
      // an unsupported method on a dropped part is irrelevant
      { name: "xl/printerSettings/p1.bin", method: 99, data: bytes("x") },
      { name: "xl/worksheets/", data: Buffer.alloc(0) },
    );
    const out = canonicalXlsx(zip);
    expect(listNames(out)).toEqual([
      "[Content_Types].xml",
      "xl/sharedStrings.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    expect(new Set(listMethods(out))).toEqual(new Set([0]));
    expect(out.equals(zip)).toBe(false);
  });

  it("is deterministic and idempotent", () => {
    const zip = withBase({ name: "xl/worksheets/sheet1.xml", data: bytes("<worksheet/>") });
    const once = canonicalXlsx(zip);
    expect(canonicalXlsx(zip).equals(once)).toBe(true);
    expect(canonicalXlsx(once).equals(once)).toBe(true);
  });

  it("accepts stored (method 0) parts and a harmless archive comment", () => {
    const zip = buildZip(
      [{ name: "[Content_Types].xml", method: 0, data: bytes("<Types/>") }, ...BASE.slice(1)],
      {
        comment: bytes("made by a spreadsheet program"),
      },
    );
    expect(code(zip)).toBeNull();
  });

  it("partCap: only the listed parts have a cap, everything else is dropped", () => {
    expect(partCap("xl/worksheets/sheet1.xml")).toBe(XLSX_LIMITS.bigPartBytes);
    expect(partCap("xl/sharedStrings.xml")).toBe(XLSX_LIMITS.bigPartBytes);
    expect(partCap("xl/styles.xml")).toBe(XLSX_LIMITS.stylesBytes);
    expect(partCap("xl/comments2.xml")).toBe(XLSX_LIMITS.smallPartBytes);
    for (const dropped of [
      "xl/media/image1.png",
      "xl/vbaProject.bin",
      "xl/worksheets/sheet1.xmlx",
      "xl/worksheetsXsheet1.xml", // the dots and slashes in the patterns are literal
      "xl/worksheets/sheet1Xxml",
      "xl/worksheets/a/b.xml",
      "xl/externalLinks/externalLink1.xml",
      "xl/Workbook.xml",
      "XL/workbook.xml",
      // names ExcelJS itself would ignore are not kept either
      "xl/worksheets/foo.xml",
      "xl/worksheets/sheet.xml",
      "xl/worksheets/_rels/foo.xml.rels",
      "xl/tables/t1.xml",
      "xl/drawings/other.vml",
      "xl/theme/a_b.xml",
      "xl/comments.xml",
    ]) {
      expect(partCap(dropped), dropped).toBeNull();
    }
  });
});

describe("canonicalXlsx: hostile names", () => {
  it.each([
    ["parent directory", "../evil.xml"],
    ["nested parent directory", "xl/../../evil.xml"],
    ["absolute path", "/etc/passwd"],
    ["backslash", "xl\\worksheets\\sheet1.xml"],
    ["drive letter", "C:/Windows/x.xml"],
    ["empty segment", "xl//worksheets/sheet1.xml"],
    ["dot segment", "xl/./worksheets/sheet1.xml"],
    ["NUL byte", "xl/worksheets/sheet1.xml\u0000.png"],
    ["control character", "xl/work\u0007sheets/sheet1.xml"],
    ["too long", "xl/" + "a".repeat(300) + ".xml"],
  ])("refuses %s, even on a part that would be dropped", (_label, name) => {
    expect(code(withBase({ name, data: bytes("x") }))).toBe("unreadable");
  });

  it("refuses a name that is not valid UTF-8", () => {
    expect(
      code(withBase({ name: Buffer.from([0x78, 0x6c, 0x2f, 0xff, 0xfe]), data: bytes("x") })),
    ).toBe("unreadable");
  });

  it("refuses duplicate names, also when only the case differs", () => {
    expect(code(withBase({ name: "xl/workbook.xml", data: bytes("<other/>") }))).toBe("unreadable");
    expect(code(withBase({ name: "XL/Workbook.XML", data: bytes("<other/>") }))).toBe("unreadable");
  });

  it("refuses a local header whose name differs from the central one", () => {
    expect(
      code(withBase({ name: "xl/styles.xml", localName: "xl/styles.xmL", data: bytes("<s/>") })),
    ).toBe("unreadable");
    expect(
      code(withBase({ name: "xl/styles.xml", localName: "xl/theme/t.xml", data: bytes("<s/>") })),
    ).toBe("unreadable");
  });

  it("refuses a directory entry that carries data", () => {
    expect(code(withBase({ name: "xl/dir/", data: bytes("not empty") }))).toBe("unreadable");
  });
});

describe("canonicalXlsx: structure and headers that lie", () => {
  it("refuses a wrong entry count, in either direction", () => {
    expect(code(buildZip(BASE, { declared: 1 }))).toBe("unreadable");
    expect(code(buildZip(BASE, { declared: 3 }))).toBe("unreadable");
    expect(code(buildZip([], {}))).toBe("unreadable");
  });

  it("refuses bytes in front of the archive whose offsets were not adjusted (JSZip would shift them)", () => {
    const stub = Buffer.alloc(64, 0x41);
    expect(code(Buffer.concat([stub, buildZip(BASE)]))).toBe("unreadable");
  });

  it("accepts bytes in front when every offset already includes them (JSZip applies no shift then)", () => {
    expect(code(buildZip(BASE, { prefix: 64 }))).toBeNull();
  });

  it.each([
    ["disk number", { diskNo: 0xffff }],
    ["disk with the directory", { diskCd: 0xffff }],
    ["entries on this disk", { onDisk: 0xffff }],
    ["a second disk", { diskNo: 1 }],
  ])("refuses archives that would switch JSZip to zip64 or multi-disk: %s", (_label, options) => {
    expect(code(buildZip(BASE, options))).toBe("unreadable");
  });

  it("refuses zip64 size markers in an entry", () => {
    expect(
      code(withBase({ name: "xl/styles.xml", data: bytes("<s/>"), compressedSize: 0xffffffff })),
    ).toBe("unreadable");
    expect(code(withBase({ name: "xl/styles.xml", data: bytes("<s/>"), size: 0xffffffff }))).toBe(
      "unreadable",
    );
  });

  it("refuses a fake end record planted in the archive comment", () => {
    const fake = Buffer.alloc(22);
    fake.writeUInt32LE(0x06054b50, 0);
    fake.writeUInt16LE(1, 8);
    fake.writeUInt16LE(1, 10);
    expect(code(buildZip(BASE, { comment: fake }))).toBe("unreadable");
  });

  it("refuses encrypted entries", () => {
    expect(code(withBase({ name: "xl/styles.xml", data: bytes("<s/>"), flags: 0x1 }))).toBe(
      "unreadable",
    );
    expect(code(withBase({ name: "xl/styles.xml", data: bytes("<s/>"), flags: 0x40 }))).toBe(
      "unreadable",
    );
  });

  it("refuses a kept part with a compression method other than stored or deflate", () => {
    expect(
      code(
        withBase({
          name: "xl/styles.xml",
          method: 12,
          raw: bytes("BZh9"),
          size: 4,
          crc: crc32(bytes("BZh9")),
        }),
      ),
    ).toBe("unreadable");
  });

  it("refuses a CRC that does not match the inflated data", () => {
    expect(code(withBase({ name: "xl/styles.xml", data: bytes("<s/>"), crc: 12345 }))).toBe(
      "unreadable",
    );
  });

  it("refuses a size that does not match the inflated data, smaller or larger", () => {
    expect(code(withBase({ name: "xl/styles.xml", data: bytes("<styles/>"), size: 3 }))).toBe(
      "unreadable",
    );
    expect(code(withBase({ name: "xl/styles.xml", data: bytes("<styles/>"), size: 99_999 }))).toBe(
      "unreadable",
    );
  });

  it("refuses data that runs past the directory, and truncated deflate data", () => {
    expect(
      code(withBase({ name: "xl/styles.xml", data: bytes("<s/>"), compressedSize: 1_000_000 })),
    ).toBe("unreadable");
    expect(
      code(
        withBase({
          name: "xl/styles.xml",
          method: 8,
          raw: Buffer.from([0xff, 0xff]),
          size: 4,
          crc: 1,
        }),
      ),
    ).toBe("unreadable");
  });

  it("refuses an archive without a workbook or content types", () => {
    expect(code(buildZip([BASE[0]!]))).toBe("unreadable");
    expect(code(buildZip([BASE[1]!]))).toBe("unreadable");
    expect(code(Buffer.from("PK\u0005\u0006"))).toBe("unreadable");
    expect(code(Buffer.alloc(10))).toBe("unreadable");
  });

  it("refuses more than 200 entries and accepts exactly 200", () => {
    const filler = (n: number): Entry[] =>
      Array.from({ length: n }, (_, i) => ({ name: `docs/f${i}.txt`, data: bytes("x") }));
    expect(code(buildZip([...BASE, ...filler(198)]))).toBeNull(); // 200 entries
    expect(code(buildZip([...BASE, ...filler(199)]))).toBe("unreadable"); // 201
  });

  it("refuses overlapping entries: one entry's data holding another entry's local header", () => {
    // Part B's local header + data are embedded inside part A's stored data; B's central entry points there.
    const inner = bytes("<theme/>");
    const innerLocal = Buffer.alloc(30);
    innerLocal.writeUInt32LE(0x04034b50, 0);
    innerLocal.writeUInt16LE(20, 4);
    innerLocal.writeUInt32LE(crc32(inner), 14);
    innerLocal.writeUInt32LE(inner.length, 18);
    innerLocal.writeUInt32LE(inner.length, 22);
    const innerName = bytes("xl/theme/theme1.xml");
    innerLocal.writeUInt16LE(innerName.length, 26);
    const hidden = Buffer.concat([innerLocal, innerName, inner]);
    const zip = buildZip([
      ...BASE,
      { name: "xl/styles.xml", method: 0, data: hidden },
      { name: "xl/theme/theme1.xml", method: 0, data: inner, pointAtData: 2 },
    ]);
    expect(code(zip)).toBe("unreadable");
  });
});

describe("canonicalXlsx: size caps are enforced on the inflated bytes", () => {
  it("refuses one part over its cap (sheet and shared strings 32 MB, styles 8 MB, small parts 4 MB)", () => {
    const over = (name: string, mb: number) => code(withBase({ name, data: Buffer.alloc(mb * MB) }));
    expect(over("xl/worksheets/sheet1.xml", 33)).toBe("size");
    expect(over("xl/sharedStrings.xml", 33)).toBe("size");
    expect(over("xl/styles.xml", 9)).toBe("size");
    expect(over("xl/tables/table1.xml", 5)).toBe("size");
  });

  it("accepts a part just under its cap", () => {
    expect(code(withBase({ name: "xl/styles.xml", data: Buffer.alloc(7 * MB) }))).toBeNull();
  });

  it("refuses parts that are each fine but together pass 64 MB", () => {
    const zip = withBase(
      { name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(30 * MB) },
      { name: "xl/worksheets/sheet2.xml", data: Buffer.alloc(30 * MB) },
      { name: "xl/worksheets/sheet3.xml", data: Buffer.alloc(30 * MB) },
    );
    expect(zip.length).toBeLessThan(2 * MB);
    expect(code(zip)).toBe("size");
  });

  it("does not spend time on a dropped part, however large it claims to be", () => {
    const bomb = deflateRawSync(Buffer.alloc(200 * MB));
    const started = Date.now();
    const out = canonicalXlsx(
      withBase({ name: "xl/media/huge.bin", raw: bomb, method: 8, size: 200 * MB, crc: 0 }),
    );
    expect(listNames(out)).not.toContain("xl/media/huge.bin");
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("parseUpload: ExcelJS only ever reads the canonical zip", () => {
  async function featureRichWorkbook(): Promise<Buffer> {
    const book = new ExcelJS.Workbook();
    const png = book.addImage({
      buffer: Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f645400000000049454e44ae426082",
        "hex",
      ) as unknown as ExcelJS.Buffer,
      extension: "png",
    });
    const sheet = book.addWorksheet("Products");
    sheet.addRow(["Name", "Price", "Link"]);
    for (let i = 0; i < 4; i++) {
      sheet.addRow([`Item ${i}`, i + 0.5, { text: "site", hyperlink: "https://example.com" }]);
    }
    sheet.mergeCells("A8:B8");
    sheet.getCell("A2").note = "a comment";
    sheet.addImage(png, "F2:G4");
    sheet.addTable({
      name: "T1",
      ref: "A10",
      headerRow: true,
      columns: [{ name: "a" }, { name: "b" }],
      rows: [[1, 2]],
    });
    // (typed loosely: ExcelJS's own typings omit dataValidations)
    (
      sheet as unknown as { dataValidations: { add: (ref: string, v: object) => void } }
    ).dataValidations.add("B2:B5", {
      type: "decimal",
      operator: "greaterThan",
      formulae: [0],
    });
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    book.addWorksheet("Second").addRow(["x"]);
    return Buffer.from(await book.xlsx.writeBuffer());
  }

  it("hands ExcelJS a different, whitelisted-only archive than the upload", async () => {
    const upload = await featureRichWorkbook();
    expect(listNames(upload).some((n) => n.startsWith("xl/media/"))).toBe(true);
    const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as {
      load: (...a: unknown[]) => Promise<unknown>;
    };
    const spy = vi.spyOn(proto, "load");
    try {
      const parsed = await parseUpload("products.xlsx", upload);
      expect(spy).toHaveBeenCalledTimes(1);
      const received = spy.mock.calls[0]?.[0] as Buffer;
      expect(Buffer.isBuffer(received)).toBe(true);
      expect(received.equals(upload)).toBe(false);
      const names = listNames(received);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(partCap(name), name).not.toBeNull();
      expect(names.some((n) => n.startsWith("xl/media/"))).toBe(false);
      expect(new Set(listMethods(received))).toEqual(new Set([0]));
      expect(parsed.headers).toEqual(["Name", "Price", "Link"]);
      // 4 product rows, plus the 2 rows of the table the workbook also holds
      expect(parsed.rows).toHaveLength(6);
      expect(parsed.rows[1]).toEqual({ Name: "Item 1", Price: "1.5", Link: "site" });
    } finally {
      spy.mockRestore();
    }
  });

  it("never calls ExcelJS at all for an archive the canonical reader refuses", async () => {
    const proto = Object.getPrototypeOf(new ExcelJS.Workbook().xlsx) as {
      load: (...a: unknown[]) => Promise<unknown>;
    };
    const spy = vi.spyOn(proto, "load");
    try {
      // Passes the cheap early guard (structure fine, small) but has a lying CRC.
      const zip = withBase({ name: "xl/styles.xml", data: bytes("<s/>"), crc: 7 });
      await expect(parseUpload("bad.xlsx", zip)).rejects.toMatchObject({ code: "unreadable" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("reads a date-styled cell with an impossible number as empty instead of crashing", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Products");
    sheet.addRow(["Name", "Price"]);
    sheet.addRow(["Tea", 3]);
    sheet.getCell("A3").value = "Odd";
    const odd = sheet.getCell("B3");
    odd.value = 1e15;
    odd.numFmt = "yyyy-mm-dd";
    const parsed = await parseUpload("dates.xlsx", Buffer.from(await book.xlsx.writeBuffer()));
    expect(parsed.rows).toEqual([
      { Name: "Tea", Price: "3" },
      { Name: "Odd", Price: "" },
    ]);
  });

  it("maps the refusal codes to the user-facing import errors", async () => {
    const bomb = withBase({ name: "xl/worksheets/sheet1.xml", data: Buffer.alloc(33 * MB) });
    const err = await parseUpload("bomb.xlsx", bomb).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportFileError);
    expect((err as ImportFileError).code).toBe("size");
  });
});
