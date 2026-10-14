// Prints the text of every page of a PDF. A separate script because pdfjs is an ES module.
//   node pdf-text.mjs <file.pdf>
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
const doc = await pdfjs.getDocument({
  data: new Uint8Array(readFileSync(process.argv[2])),
  useSystemFonts: true,
}).promise;
const pages = [];
for (let i = 1; i <= doc.numPages; i++) {
  const content = await (await doc.getPage(i)).getTextContent();
  pages.push(content.items.map((x) => x.str).join(" "));
}
process.stdout.write(pages.join("\n"));
