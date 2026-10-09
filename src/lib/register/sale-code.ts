/** The receipt barcode text that finds a sale again: "TF" + the sale id without dashes. */
export const saleCode = (saleId: string) => `TF${saleId.replaceAll("-", "")}`;

/** The sale id behind a scanned receipt code, or null when the text is not one. */
export function saleIdOfCode(code: string): string | null {
  const m = /^TF([0-9a-fA-F]{32})$/.exec(code.trim());
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
