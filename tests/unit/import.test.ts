import { deflateRawSync } from "node:zlib";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { errorsCsv } from "@/lib/import/errors-file";
import type { Mapping } from "@/lib/import/fields";
import { ImportFileError, MAX_ROWS, parseUpload } from "@/lib/import/parse";
import { autoMatch, detectSource } from "@/lib/import/presets";
import { buildItems, derivedId, taxCategoryFrom } from "@/lib/import/validate";

const ID = "0197f3a0-0000-7000-8000-000000000001";
const buf = (s: string) => Buffer.from(s, "utf8");
const code = async (name: string, bytes: Buffer) =>
  parseUpload(name, bytes).then(
    () => null,
    (e: unknown) => (e instanceof ImportFileError ? e.code : "other"),
  );

describe("parseUpload", () => {
  it("reads CSV, trimming cells and ignoring blank lines and a BOM", async () => {
    const p = await parseUpload("a.csv", buf("﻿Name,Price\n Tea ,3.50\n\nCoffee,4\n"));
    expect(p.headers).toEqual(["Name", "Price"]);
    expect(p.rows).toEqual([
      { Name: "Tea", Price: "3.50" },
      { Name: "Coffee", Price: "4" },
    ]);
  });

  it("reads JSON arrays and { products: [] }, joining list values", async () => {
    const a = await parseUpload(
      "a.json",
      buf(JSON.stringify([{ name: "Tea", allergens: ["milk", "nuts"], price: 3.5 }])),
    );
    expect(a.rows[0]).toEqual({ name: "Tea", allergens: "milk;nuts", price: "3.5" });
    const b = await parseUpload("b.json", buf(JSON.stringify({ products: [{ name: "X" }] })));
    expect(b.rows).toEqual([{ name: "X" }]);
  });

  it("reads the first sheet of an xlsx and uses a formula's stored result, never running it", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Products");
    sheet.addRow(["Name", "Price"]);
    sheet.addRow(["Tea", 3.5]);
    sheet.addRow(["Evil", { formula: "1+1", result: 2 }]);
    const bytes = Buffer.from(await book.xlsx.writeBuffer());
    const p = await parseUpload("a.xlsx", bytes);
    expect(p.rows).toEqual([
      { Name: "Tea", Price: "3.5" },
      { Name: "Evil", Price: "2" },
    ]);
  });

  it("refuses .sql with its own code, whatever the content, and other types", async () => {
    expect(await code("dump.sql", buf("INSERT INTO products VALUES (1);"))).toBe("sql");
    expect(await code("DUMP.SQL", buf("select 1"))).toBe("sql");
    expect(await code("a.exe", buf("x"))).toBe("type");
    expect(await code("a.csv.sql", buf("x"))).toBe("sql");
    expect(await code("noext", buf("x"))).toBe("type");
  });

  it("refuses wrong content for the extension", async () => {
    expect(await code("a.xlsx", buf("Name,Price\nTea,3"))).toBe("unreadable");
    expect(await code("a.csv", Buffer.from([0x50, 0x4b, 0, 0]))).toBe("unreadable");
    expect(await code("a.json", buf("{nope"))).toBe("unreadable");
    expect(await code("a.json", buf('{"x":1}'))).toBe("unreadable");
    expect(await code("a.csv", buf(""))).toBe("empty");
    expect(await code("a.csv", buf("Name,Price\n"))).toBe("empty");
  });

  it("enforces the size, column and row limits", async () => {
    expect(await code("a.csv", Buffer.alloc(10 * 1024 * 1024 + 1, "a"))).toBe("size");
    const wide = Array.from({ length: 61 }, (_, i) => `c${i}`).join(",");
    expect(await code("a.csv", buf(`${wide}\n${wide}`))).toBe("columns");
    const many = "Name,Price\n" + "T,1\n".repeat(MAX_ROWS + 1);
    expect(await code("a.csv", buf(many))).toBe("rows");
    expect(await code("a.csv", buf("Name,Price\n" + "T,1\n".repeat(MAX_ROWS)))).toBeNull();
  });

  it("makes repeated headers unique", async () => {
    const p = await parseUpload("a.csv", buf("Name,Name,\nA,B,C"));
    expect(p.headers).toEqual(["Name", "Name (2)", "Column 3"]);
  });
});

describe("presets and auto match", () => {
  it("matches common column names, one column per field", () => {
    const m = autoMatch([
      "Product Name",
      "Retail Price",
      "Barcode",
      "SKU",
      "Category",
      "Qty",
      "Cost",
    ]);
    expect(m).toMatchObject({
      name: "Product Name",
      price: "Retail Price",
      barcode: "Barcode",
      sku: "SKU",
      category: "Category",
      openingStock: "Qty",
      cost: "Cost",
    });
  });

  it.each([
    [
      "square",
      ["Item Name", "Variation Name", "SKU", "GTIN", "Categories", "Price", "Default Unit Cost"],
    ],
    [
      "shopify",
      ["Handle", "Title", "Vendor", "Type", "Variant SKU", "Variant Price", "Variant Barcode"],
    ],
    ["lightspeed", ["name", "sku", "barcode", "product_category", "retail_price", "supply_price"]],
    ["imonggo", ["Name", "Stock No", "Barcode", "Category", "Retail Price", "Cost"]],
  ] as const)("detects %s and maps its price and name", (id, headers) => {
    expect(detectSource([...headers])).toBe(id);
    const m = autoMatch([...headers], id);
    expect(m.name && m.price).toBeTruthy();
  });

  it("detects nothing for a plain file", () => {
    expect(detectSource(["Name", "Price"])).toBeNull();
  });
});

describe("taxCategoryFrom", () => {
  it("accepts names and percentages", () => {
    expect(taxCategoryFrom("standard", "general")).toBe("STANDARD");
    expect(taxCategoryFrom("23%", "general")).toBe("STANDARD");
    expect(taxCategoryFrom("13,5", "general")).toBe("REDUCED");
    expect(taxCategoryFrom("0", "general")).toBe("ZERO");
    expect(taxCategoryFrom("9", "general")).toBe("SECOND_REDUCED");
    expect(taxCategoryFrom("9", "cafe")).toBe("CATERING");
    expect(taxCategoryFrom("", "general")).toBe("");
    expect(taxCategoryFrom("21", "general")).toBeNull();
    expect(taxCategoryFrom("=1+1", "general")).toBeNull();
  });
});

const map: Mapping = {
  name: "Name",
  price: "Price",
  sku: "SKU",
  barcode: "Barcode",
  taxCategory: "VAT",
  category: "Category",
  openingStock: "Stock",
};
const row = (o: Record<string, string>) => ({
  Name: "",
  Price: "",
  SKU: "",
  Barcode: "",
  VAT: "",
  Category: "",
  Stock: "",
  ...o,
});

describe("buildItems", () => {
  it("builds products with cents, VAT category, stock and category", () => {
    const r = buildItems(
      ID,
      "general",
      [
        row({
          Name: "Bread",
          Price: "2.49",
          SKU: "B1",
          Barcode: "5390001",
          VAT: "0",
          Category: "Grocery",
          Stock: "12",
        }),
      ],
      map,
    );
    expect(r.errors).toEqual([]);
    expect(r.items).toHaveLength(1);
    const item = r.items[0]!;
    expect(item.category).toBe("Grocery");
    expect(item.product).toMatchObject({ name: "Bread", tax_category: "ZERO", track_stock: true });
    expect(item.variants[0]).toMatchObject({
      price_incl_vat_cents: 249,
      sku: "B1",
      barcode: "5390001",
      opening_stock: 12,
    });
  });

  it("lists bad rows with row numbers and still imports the good ones", () => {
    const r = buildItems(
      ID,
      "general",
      [
        row({ Name: "Good", Price: "1.00" }),
        row({ Name: "", Price: "1.00" }),
        row({ Name: "Bad price", Price: "abc" }),
        row({ Name: "Bad VAT", Price: "1", VAT: "21" }),
        row({ Name: "Bad barcode", Price: "1", Barcode: "has space!" }),
        row({ Name: "Bad stock", Price: "1", Stock: "-4" }),
      ],
      map,
    );
    expect(r.items.map((i) => i.product.name)).toEqual(["Good"]);
    expect(new Set(r.errors.map((e) => e.row))).toEqual(new Set([3, 4, 5, 6, 7]));
    expect(r.errors.find((e) => e.row === 5)?.field).toBe("taxCategory");
  });

  it("refuses the later row when a barcode or SKU repeats in the file", () => {
    const r = buildItems(
      ID,
      "general",
      [
        row({ Name: "A", Price: "1", Barcode: "111", SKU: "S1" }),
        row({ Name: "B", Price: "1", Barcode: "111", SKU: "S2" }),
        row({ Name: "C", Price: "1", Barcode: "333", SKU: "S1" }),
      ],
      map,
    );
    expect(r.items.map((i) => i.product.name)).toEqual(["A"]);
    expect(r.errors.map((e) => [e.row, e.field])).toEqual([
      [3, "barcode"],
      [4, "sku"],
    ]);
  });

  it("ignores columns the business type does not use (no barcode in a café)", () => {
    const r = buildItems(
      ID,
      "cafe",
      [row({ Name: "Latte", Price: "3.50", Barcode: "bad barcode!", VAT: "9" })],
      map,
    );
    expect(r.errors).toEqual([]);
    expect(r.items[0]!.variants[0]!.barcode).toBeNull();
    expect(r.items[0]!.product).toMatchObject({
      tax_category: "CATERING",
      takeaway_tax_category: "CATERING",
    });
  });

  it("defaults a blank VAT rate and counts it", () => {
    const r = buildItems(
      ID,
      "general",
      [row({ Name: "A", Price: "1" }), row({ Name: "B", Price: "1", VAT: "23" })],
      map,
    );
    expect(r.vatDefaulted).toBe(1);
    expect(r.items[0]!.product.tax_category).toBe("STANDARD");
  });

  it("requires size and colour for clothing and groups variants by style", () => {
    const m: Mapping = { ...map, size: "Size", colour: "Colour", styleCode: "Style" };
    const c = (o: Record<string, string>) => ({ ...row(o), Size: "", Colour: "", Style: "", ...o });
    const r = buildItems(
      ID,
      "clothing",
      [
        c({ Name: "Tee", Price: "20", Style: "T1", Size: "M", Colour: "Black" }),
        c({ Name: "Tee", Price: "20", Style: "T1", Size: "L", Colour: "Black" }),
        c({ Name: "Tee", Price: "20", Style: "T1", Size: "M", Colour: "Black" }),
        c({ Name: "Tee", Price: "20", Style: "T1", Size: "", Colour: "Black" }),
        c({ Name: "Hat", Price: "9", Style: "H1", Size: "S", Colour: "Red" }),
      ],
      m,
    );
    expect(r.items).toHaveLength(2);
    expect(r.items[0]!.variants).toHaveLength(2);
    expect(r.items[0]!.rows).toEqual([2, 3]);
    expect(new Set(r.errors.map((e) => e.row))).toEqual(new Set([4, 5]));
  });

  it("keeps formula-looking text as plain text and escapes it in the problem file", () => {
    const rows = [row({ Name: "=HYPERLINK(1)", Price: "x" })];
    const r = buildItems(ID, "general", rows, map);
    const csv = errorsCsv(["Name", "Price"], [{ Name: rows[0]!.Name, Price: "x" }], r.errors);
    expect(csv).toContain("'=HYPERLINK(1)");
    expect(csv.split("\r\n")[0]).toContain("Row,Problems,Name,Price");
  });

  it("gives the same ids for the same import and row, different ids otherwise", () => {
    expect(derivedId(ID, "v:2")).toBe(derivedId(ID, "v:2"));
    expect(derivedId(ID, "v:2")).not.toBe(derivedId(ID, "v:3"));
    expect(derivedId(ID, "v:2")).not.toBe(derivedId("0197f3a0-0000-7000-8000-000000000002", "v:2"));
    expect(derivedId(ID, "v:2")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("handles a 10,000 row file: parse, validate, mixed bad rows", async () => {
    const lines = ["Name,Price,SKU,Barcode,VAT,Category,Stock"];
    for (let i = 0; i < 10_000; i++) {
      const bad = i % 100 === 0; // 100 bad prices
      const dupBarcode = i === 5_001; // repeats the barcode of i=4,999
      lines.push(
        `Item ${i},${bad ? "n/a" : (1 + (i % 50)).toFixed(2)},SKU${i},${dupBarcode ? "9000004999" : `9${String(i).padStart(9, "0")}`},23,Cat ${i % 20},${i % 7}`,
      );
    }
    const t0 = Date.now();
    const parsed = await parseUpload("big.csv", buf(lines.join("\n")));
    const r = buildItems(ID, "general", parsed.rows, map);
    expect(parsed.rows).toHaveLength(10_000);
    expect(r.items.length + new Set(r.errors.map((e) => e.row)).size).toBe(10_000);
    expect(new Set(r.errors.map((e) => e.row)).size).toBe(101);
    expect(r.variantCount).toBe(9_899);
    expect(new Set(r.items.flatMap((i) => i.variants.map((v) => v.id))).size).toBe(9_899);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});
/** A minimal one-part zip whose single file inflates to `size` zero bytes (sizes in the headers are honest). */
function zipOf(size: number): Buffer {
  const data = deflateRawSync(Buffer.alloc(size));
  const name = Buffer.from("xl/big.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  const cdOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

describe("upload abuse limits", () => {
  it("refuses an xlsx that inflates past the cap", async () => {
    const bomb = zipOf(150 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    expect(await code("bomb.xlsx", bomb)).toBe("size");
  });

  it("refuses JSON with too many distinct keys before building any rows", async () => {
    const objs = Array.from({ length: 2_000 }, (_, i) => ({ [`k${i}`]: 1 }));
    expect(await code("wide.json", buf(JSON.stringify(objs)))).toBe("columns");
  });

  it("does not let a column named like an Object method break a row", () => {
    const r = buildItems(ID, "general", [{ Name: "Tea", Price: "2" }], {
      name: "Name",
      price: "Price",
      sku: "constructor",
    });
    expect(r.errors).toEqual([]);
    expect(r.items[0]!.variants[0]!.sku).toBeNull();
  });

  it("tells an update which values the file actually gave", () => {
    const m: Mapping = {
      name: "Name",
      price: "Price",
      taxCategory: "VAT",
      deposit: "Deposit",
    };
    const r = buildItems(
      ID,
      "general",
      [
        { Name: "A", Price: "1", VAT: "", Deposit: "" },
        { Name: "B", Price: "1", VAT: "23", Deposit: "0.15" },
      ],
      m,
    );
    expect(r.items[0]!.product.tax_set).toBe(false);
    expect(r.items[0]!.variants[0]!.attr_set).toEqual([]);
    expect(r.items[1]!.product.tax_set).toBe(true);
    expect(r.items[1]!.variants[0]!.attr_set).toEqual(["depositCents"]);
  });
});
/**
 * A zip with several parts, built by hand so a test can lie in the headers. `declared` is the entry
 * count written in the end record; `prefix` bytes are put in front (offsets then no longer match).
 */
function zipParts(
  parts: { name: string; size: number }[],
  declared = parts.length,
  prefix = 0,
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const data = deflateRawSync(Buffer.alloc(part.size));
    const name = Buffer.from(part.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(part.size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(part.size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(declared, 8);
  end.writeUInt16LE(declared, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.alloc(prefix, 0x41), ...locals, dir, end]);
}

describe("zip parser differentials (what the check sees is what ExcelJS reads)", () => {
  const BOMB = 150 * 1024 * 1024;

  it("refuses a directory that holds more entries than the end record declares", async () => {
    // The end record says 1 entry; JSZip would read all 2 and inflate the bomb.
    const zip = zipParts(
      [
        { name: "[Content_Types].xml", size: 10 },
        { name: "xl/worksheets/sheet1.xml", size: BOMB },
      ],
      1,
    );
    expect(["size", "unreadable"]).toContain(await code("sneaky.xlsx", zip));
  });

  it("refuses a zip with bytes in front, which would shift JSZip's offsets", async () => {
    const zip = zipParts(
      [{ name: "xl/worksheets/sheet1.xml", size: BOMB }],
      1,
      64,
    );
    expect(await code("prefixed.xlsx", zip)).toBe("unreadable");
  });

  it("refuses several modest parts that together pass the cap, and counts the real output", async () => {
    const parts = Array.from({ length: 3 }, (_, i) => ({
      name: `xl/p${i}.xml`,
      size: 40 * 1024 * 1024,
    }));
    expect(await code("many.xlsx", zipParts(parts))).toBe("size");
  });

  it("refuses any disk-number field that would switch JSZip to zip64, where it reads another directory", async () => {
    for (const field of [4, 6, 8]) {
      const zip = zipParts([{ name: "xl/worksheets/sheet1.xml", size: BOMB }]);
      zip.writeUInt16LE(0xffff, zip.length - 22 + field);
      expect(await code("zip64.xlsx", zip)).toBe("unreadable");
    }
  });

  it("still accepts a normal workbook written by ExcelJS (data descriptors, comments and all)", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Products");
    sheet.addRow(["Name", "Price"]);
    for (let i = 0; i < 500; i++) sheet.addRow([`Item ${i}`, i]);
    const p = await parseUpload(
      "ok.xlsx",
      Buffer.from(await book.xlsx.writeBuffer()),
    );
    expect(p.rows).toHaveLength(500);
  });
});
