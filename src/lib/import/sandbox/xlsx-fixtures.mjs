// Builds minimal .xlsx files by hand (no ExcelJS), for the tests and the probe: a small valid
// workbook, and workbooks whose XML is hostile to ExcelJS while the zip around it is perfectly clean.
import { crc32, writeStoredZip } from "../xlsx-zip.mjs";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const colName = (i) => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/**
 * The text of a worksheet part.
 * @param {{ rows?: string[][], before?: string, after?: string }} o
 *   `before` goes ahead of <sheetData> (for <cols>), `after` behind it (for <mergeCells>).
 */
export function sheetXml({ rows = [], before = "", after = "" } = {}) {
  const body = rows
    .map(
      (cells, r) =>
        `<row r="${r + 1}">` +
        cells
          .map((v, c) => `<c r="${colName(c)}${r + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`)
          .join("") +
        "</row>",
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${NS}" xmlns:r="${REL}">${before}<sheetData>${body}</sheetData>${after}</worksheet>`;
}

/**
 * A clean zip around the given worksheet XML.
 * @param {string | Buffer} sheet
 * @returns {Buffer}
 */
export function workbookWithSheet(sheet) {
  const part = (name, text) => {
    const data = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
    return { name: Buffer.from(name, "ascii"), data, crc: crc32(data) };
  };
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  return writeStoredZip([
    part(
      "[Content_Types].xml",
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    part(
      "_rels/.rels",
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    part(
      "xl/workbook.xml",
      `${head}<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    ),
    part(
      "xl/_rels/workbook.xml.rels",
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    part("xl/worksheets/sheet1.xml", sheet),
  ]);
}

/** Header and a couple of product rows: the smallest workbook the importer can read. */
export const TINY_ROWS = [
  ["Name", "Price"],
  ["Tea", "3.5"],
  ["Coffee", "4"],
];
export const tinyWorkbook = () => workbookWithSheet(sheetXml({ rows: TINY_ROWS }));

// ---- hostile sheets: a few hundred bytes of XML that ExcelJS expands into gigabytes of objects
/** One merged range of ~5 million cells (ExcelJS creates a cell object for each). */
export const mergeBomb = () =>
  workbookWithSheet(
    sheetXml({
      rows: TINY_ROWS,
      after: '<mergeCells count="1"><mergeCell ref="A1:AZ100000"/></mergeCells>',
    }),
  );
/** A column definition spanning millions of columns. */
export const colBomb = () =>
  workbookWithSheet(
    sheetXml({ rows: TINY_ROWS, before: '<cols><col min="1" max="3000000" width="10"/></cols>' }),
  );
/** A sheet that claims a row far past the limit. */
export const farRow = () =>
  workbookWithSheet(
    sheetXml({ rows: TINY_ROWS }).replace(
      "</sheetData>",
      '<row r="1048576"><c r="A1048576" t="inlineStr"><is><t>x</t></is></c></row></sheetData>',
    ),
  );
/** More than 50,000 genuine rows (small cells, so the XML stays modest). */
export const tooManyRows = (n = 50_100) =>
  workbookWithSheet(
    sheetXml({
      rows: [["Name", "Price"], ...Array.from({ length: n }, (_, i) => [`Item ${i}`, "1"])],
    }),
  );
