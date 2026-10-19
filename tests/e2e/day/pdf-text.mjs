// Prints the text of a PDF. A separate script because pdfjs is an ES module.
//   node pdf-text.mjs <file.pdf>          one printed row per line: the text pieces on the same
//                                         baseline, left to right, pages in order
//   node pdf-text.mjs <file.pdf> flow     the pieces in the order they were drawn (headings that wrap
//                                         over several lines stay in reading order)
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync(process.argv[2])),
  useSystemFonts: true,
}).promise;

const flow = process.argv[3] === "flow";
const out = [];
for (let i = 1; i <= doc.numPages; i++) {
  const content = await (await doc.getPage(i)).getTextContent();
  if (flow) {
    out.push(content.items.map((x) => ("str" in x ? x.str : "")).join(" "));
    continue;
  }
  const rows = []; // { y, items: [{ x, str }] }
  for (const item of content.items) {
    if (!("str" in item) || item.str === "") continue;
    const y = item.transform[5];
    const x = item.transform[4];
    // The same row when the baselines are within 2 points.
    let row = rows.find((r) => Math.abs(r.y - y) < 2);
    if (!row) rows.push((row = { y, items: [] }));
    row.items.push({ x, str: item.str });
  }
  rows.sort((a, b) => b.y - a.y); // top of the page first
  for (const r of rows) {
    r.items.sort((a, b) => a.x - b.x);
    out.push(r.items.map((p) => p.str).join(" "));
  }
}
process.stdout.write(out.join("\n"));
