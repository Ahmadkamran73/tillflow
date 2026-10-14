import "server-only";
import ExcelJS from "exceljs";
import { csvRow, safeText } from "@/lib/csv";
import { t } from "@/lib/i18n";
import { plainCell, showCell, type ReportTable } from "@/lib/reports/table";

export const EXPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** What a file says about itself: the shop, the dates, when it was made. */
export type ExportMeta = { shop: string; range: string; madeAt: string };

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

// Numbers are generated from integers by us, so only text can carry a formula.
const NUMBER = /^-?\d+(\.\d+)?$/;

/** CSV with a byte-order mark so Excel opens the euro sign and accents correctly. */
export function toCsv(table: ReportTable): string {
  const cols = table.columns;
  const line = (cells: (string | number)[]) =>
    cols
      .map((c, i) => {
        const v = cells[i] ?? "";
        const plain = plainCell(c.kind, v);
        return c.kind !== "text" && NUMBER.test(plain) ? plain : csvRow([plain]);
      })
      .join(",");
  const lines = [
    csvRow(cols.map((c) => t(c.label))),
    ...table.rows.map(line),
    ...(table.totals ? [line(table.totals)] : []),
  ];
  return `﻿${lines.join("\r\n")}\r\n`;
}

/** An .xlsx workbook: money as numbers with a currency format, text made formula-safe. */
export async function toXlsx(table: ReportTable, meta: ExportMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Tillflow";
  wb.created = new Date();
  const sheet = wb.addWorksheet(
    t(table.title)
      .slice(0, 31)
      .replace(/[\\/?*[\]:]/g, " "),
  );
  sheet.addRow([safeText(`${meta.shop} · ${t(table.title)}`)]).font = { bold: true, size: 13 };
  sheet.addRow([safeText(meta.range)]);
  sheet.addRow([]);
  const header = sheet.addRow(table.columns.map((c) => t(c.label)));
  header.font = { bold: true };
  header.alignment = { vertical: "middle", wrapText: true };
  const put = (cells: (string | number)[], bold = false) => {
    const row = sheet.addRow(
      table.columns.map((c, i) => {
        const v = cells[i] ?? "";
        if (typeof v === "string") return safeText(v);
        return c.kind === "money" ? Number(plainCell("money", v)) : v;
      }),
    );
    if (bold) row.font = { bold: true };
    table.columns.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      if (c.kind === "money") cell.numFmt = '"€"#,##0.00;[Red]-"€"#,##0.00';
      if (c.kind !== "text") cell.alignment = { horizontal: "right" };
    });
  };
  for (const r of table.rows) put(r);
  if (table.totals) put(table.totals, true);
  table.columns.forEach((c, i) => {
    sheet.getColumn(i + 1).width = c.kind === "text" ? 28 : 16;
  });
  sheet.views = [{ state: "frozen", ySplit: 4 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Text for the PDF: the same strings the screen shows. */
export const pdfRows = (table: ReportTable): string[][] => {
  const show = (cells: (string | number)[]) =>
    table.columns.map((c, i) => showCell(c.kind, cells[i] ?? ""));
  return [...table.rows.map(show), ...(table.totals ? [show(table.totals)] : [])];
};
