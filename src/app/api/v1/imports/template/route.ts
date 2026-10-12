import ExcelJS from "exceljs";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { businessTypes } from "@/config/business-type-presets";
import { authorizeApi } from "@/lib/auth";
import { csvRow } from "@/lib/csv";
import { templateRows } from "@/lib/import/fields";
import { getOrganisation } from "@/lib/org";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/imports/template?orgId=&format=csv|xlsx[&type=]: an empty product file with the
 * columns that business type uses and one example row. Defaults to the shop's own type.
 */
export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  const orgId = z.uuid().safeParse(q.get("orgId"));
  if (!orgId.success) return new Response(null, { status: 404 });
  const auth = await authorizeApi(["owner", "manager"], orgId.data);
  if (!auth.ok) return new Response(null, { status: auth.status });

  const org = await getOrganisation(orgId.data);
  if (!org) return new Response(null, { status: 404 });
  const asked = z.enum(businessTypes).safeParse(q.get("type"));
  const type = asked.success ? asked.data : (org.businessType as (typeof businessTypes)[number]);
  const rows = templateRows(type);
  const base = `tillflow-products-${type}`;

  if (q.get("format") === "xlsx") {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Products");
    rows.forEach((r) => sheet.addRow(r));
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((c) => (c.width = 24));
    const buffer = await book.xlsx.writeBuffer();
    return new Response(buffer as ArrayBuffer, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${base}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  }
  return new Response(`﻿${rows.map(csvRow).join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${base}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
