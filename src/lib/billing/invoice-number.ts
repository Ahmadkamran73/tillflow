/** `INV-000123`: sequential, no gaps, never reused (the number comes from the database counter). */
export const invoiceNumber = (n: number) => `INV-${String(n).padStart(6, "0")}`;
export const invoiceFileName = (n: number) => `${invoiceNumber(n)}.pdf`;
