# Real spreadsheet exports (compatibility fixtures)

**Status: UNVERIFIED.** This folder is empty on purpose. The test
`tests/unit/import-xlsx-real-exports.test.ts` runs every `.xlsx` file placed here through the same
import path as an upload (canonical re-zip, and from Layer 2 the sandbox), and is **skipped while the
folder has no files**. Until genuine files are added and that test passes, nothing here claims that
workbooks saved by Excel, LibreOffice or Google Sheets import correctly. Workbooks written by the
ExcelJS library in the unit tests are synthetic and do not count as evidence.

## How to add files

Make each file by hand in the real program, with **no real customer or business data**.

1. In the program, create one sheet named `Products` with exactly this content (type the prices as
   numbers; format the SKU and Barcode columns as text so leading zeros survive):

   | Name           | Price | SKU  | Barcode | VAT rate | Category | Opening stock |
   | -------------- | ----- | ---- | ------- | -------- | -------- | ------------- |
   | Brennans Bread | 2.49  | BRD1 | 5390001 | 0        | Grocery  | 12            |
   | Milk 1L        | 1.35  | MLK1 | 5390002 | 0        | Grocery  | 30            |
   | Cola           | 1.80  | COLA | 5390005 | 23       | Drinks   | 6             |

2. Save as `.xlsx` (Excel: "Excel Workbook"; LibreOffice: "Excel 2007-365"; Google Sheets: File >
   Download > Microsoft Excel) and name the file `<producer>-<note>.xlsx`, where the producer is
   `excel`, `libreoffice` or `sheets`. Example: `excel-365-windows.xlsx`.
3. Optional extras that real files often have, each as its own file with a matching name: a hyperlink
   cell, a table (Ctrl+T), a picture, a comment, a second sheet, a frozen header row.
4. If a file should produce something other than the table above, add `<same name>.expected.json`:
   `{ "headers": [...], "rows": [ { "Name": "..." } ] }`. Cell values are read as text, so a price
   typed as 1.80 is read as `"1.8"`.

The test fails if a file's name does not start with a known producer, so a mislabelled file cannot
be counted as evidence for the wrong program.
