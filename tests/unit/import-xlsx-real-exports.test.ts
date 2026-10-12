// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseUpload } from "@/lib/import/parse";

// Genuine Excel / LibreOffice / Google Sheets exports. See tests/fixtures/xlsx-real/README.md.
// With no files this whole group is skipped, and the todo below keeps the gap visible in every run.

const dir = path.join(process.cwd(), "tests", "fixtures", "xlsx-real");
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".xlsx"))
  : [];
const PRODUCERS = ["excel", "libreoffice", "sheets"];

const STANDARD = {
  headers: ["Name", "Price", "SKU", "Barcode", "VAT rate", "Category", "Opening stock"],
  rows: [
    {
      Name: "Brennans Bread",
      Price: "2.49",
      SKU: "BRD1",
      Barcode: "5390001",
      "VAT rate": "0",
      Category: "Grocery",
      "Opening stock": "12",
    },
    {
      Name: "Milk 1L",
      Price: "1.35",
      SKU: "MLK1",
      Barcode: "5390002",
      "VAT rate": "0",
      Category: "Grocery",
      "Opening stock": "30",
    },
    {
      Name: "Cola",
      Price: "1.8",
      SKU: "COLA",
      Barcode: "5390005",
      "VAT rate": "23",
      Category: "Drinks",
      "Opening stock": "6",
    },
  ],
};

it.todo(
  "UNVERIFIED: real Excel, LibreOffice and Google Sheets exports (add genuine files to tests/fixtures/xlsx-real)",
);

describe.skipIf(files.length === 0)("real spreadsheet exports", () => {
  it.each(files)("%s imports as the sheet that was typed into the program", async (file) => {
    expect(
      PRODUCERS.some((p) => file.toLowerCase().startsWith(`${p}-`)),
      "file name must start with excel-, libreoffice- or sheets-",
    ).toBe(true);
    const expectedFile = path.join(dir, file.replace(/\.xlsx$/i, ".expected.json"));
    const expected = fs.existsSync(expectedFile)
      ? JSON.parse(fs.readFileSync(expectedFile, "utf8"))
      : STANDARD;
    const parsed = await parseUpload(file, fs.readFileSync(path.join(dir, file)));
    expect(parsed.headers).toEqual(expected.headers);
    expect(parsed.rows).toEqual(expected.rows);
  });
});
