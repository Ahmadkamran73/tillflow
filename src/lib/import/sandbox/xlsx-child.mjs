// Entry point of the sandboxed xlsx parser. Started by runner.mjs as
//   node --max-old-space-size=N --permission --allow-fs-read=<this folder, node_modules> xlsx-child.mjs
// with an empty environment, no database access and no credentials. It reads the uploaded file from
// stdin and writes ONE line of JSON to stdout, nothing else:
//   {"ok":true,"headers":[...],"matrix":[[...]]}   or   {"ok":false,"code":"unreadable"|"size"|...}
// The parent kills it on a timeout, on too much memory or on too much output, and validates the
// JSON before using any of it.
import { MAX_FILE_BYTES } from "../limits.mjs";
import { readXlsx, XlsxReadError } from "./xlsx-read.mjs";

/** @param {unknown} answer */
function finish(answer) {
  process.stdout.write(`${JSON.stringify(answer)}\n`, () => process.exit(0));
}

async function main() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > MAX_FILE_BYTES) return finish({ ok: false, code: "size" });
    chunks.push(chunk);
  }
  try {
    const { headers, matrix } = await readXlsx(Buffer.concat(chunks));
    finish({ ok: true, headers, matrix });
  } catch (e) {
    finish({ ok: false, code: e instanceof XlsxReadError ? e.code : "unreadable" });
  }
}

main();
