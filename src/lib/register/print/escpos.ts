// ESC/POS bytes for a thermal receipt printer. Text goes out in code page 858 (has the euro sign).
const CP858: Record<string, number> = {
  "€": 0xd5,
  á: 0xa0,
  é: 0x82,
  í: 0xa1,
  ó: 0xa2,
  ú: 0xa3,
  Á: 0xb5,
  É: 0x90,
  Í: 0xd6,
  Ó: 0xe0,
  Ú: 0xe9,
};

const byteOf = (ch: string) => {
  const code = ch.charCodeAt(0);
  if (code >= 0x20 && code < 0x7f) return code;
  if (CP858[ch] !== undefined) return CP858[ch];
  return ch === "·" ? 0x2e : 0x3f; // middle dot → ".", anything else → "?"
};

/**
 * A receipt line that starts with this is not text but a barcode of the rest of the line (Code 128),
 * so a later scan can find the sale again. Printers without ESC/POS (browser printing) show the
 * code as plain text instead.
 */
export const BARCODE_MARK = "";

/** Drawer-kick pulse on pin 2 (the usual RJ11 wiring). */
export const DRAWER_KICK = [0x1b, 0x70, 0x00, 0x19, 0xfa];

export function encodeEscpos(
  lines: readonly string[],
  opts: { cut?: boolean; kick?: boolean } = {},
): Uint8Array {
  const out: number[] = [0x1b, 0x40, 0x1b, 0x74, 19]; // init, select code page 858
  for (const line of lines) {
    if (line.startsWith(BARCODE_MARK)) {
      // Centred Code 128 (set B), 56 dots high, text printed under it.
      const code = line.slice(BARCODE_MARK.length).replace(/[^0-9A-Za-z]/g, "");
      if (code.length > 0 && code.length <= 60) {
        out.push(0x1b, 0x61, 0x01, 0x1d, 0x68, 56, 0x1d, 0x77, 2, 0x1d, 0x48, 2);
        out.push(0x1d, 0x6b, 0x49, code.length + 2, 0x7b, 0x42);
        for (const ch of code) out.push(ch.charCodeAt(0));
        out.push(0x0a, 0x1b, 0x61, 0x00);
      }
      continue;
    }
    for (const ch of line) out.push(byteOf(ch));
    out.push(0x0a);
  }
  out.push(0x0a, 0x0a, 0x0a);
  if (opts.cut !== false) out.push(0x1d, 0x56, 0x42, 0x00); // feed and partial cut
  if (opts.kick) out.push(...DRAWER_KICK);
  return Uint8Array.from(out);
}
