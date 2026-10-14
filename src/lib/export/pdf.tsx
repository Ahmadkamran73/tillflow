import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { t } from "@/lib/i18n";
import type { ReportTable } from "@/lib/reports/table";
import { pdfRows, type ExportMeta } from "./tabular";

const s = StyleSheet.create({
  page: { padding: 28, fontSize: 9, fontFamily: "Helvetica", color: "#111111" },
  shop: { fontSize: 9, color: "#555555" },
  title: { fontSize: 16, fontFamily: "Helvetica-Bold", marginTop: 2 },
  range: { marginTop: 2, marginBottom: 12, color: "#333333" },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#bbbbbb",
    paddingVertical: 3,
  },
  head: { borderBottomWidth: 1, borderBottomColor: "#111111", fontFamily: "Helvetica-Bold" },
  total: { fontFamily: "Helvetica-Bold", borderTopWidth: 1, borderTopColor: "#111111" },
  foot: { position: "absolute", bottom: 14, left: 28, right: 28, fontSize: 7, color: "#666666" },
});

/** Wider first column, equal numeric columns, right-aligned numbers. */
const widthOf = (i: number, n: number) => (i === 0 ? 2 : n > 6 ? 1 : 1.2);

function ReportPdf({ table, meta }: { table: ReportTable; meta: ExportMeta }) {
  const n = table.columns.length;
  const rows = pdfRows(table);
  const cell = (text: string, i: number, key: string) => (
    <Text
      key={key}
      style={{
        flex: widthOf(i, n),
        textAlign: table.columns[i]!.kind === "text" ? "left" : "right",
        paddingHorizontal: 3,
      }}
    >
      {text}
    </Text>
  );
  return (
    <Document title={t(table.title)} author="Tillflow">
      <Page size="A4" orientation="landscape" style={s.page} wrap>
        <Text style={s.shop}>{meta.shop}</Text>
        <Text style={s.title}>{t(table.title)}</Text>
        <Text style={s.range}>{meta.range}</Text>
        <View style={[s.row, s.head]} fixed>
          {table.columns.map((c, i) => cell(t(c.label), i, `h${i}`))}
        </View>
        {rows.map((r, ri) => (
          <View
            key={ri}
            style={table.totals && ri === rows.length - 1 ? [s.row, s.total] : s.row}
            wrap={false}
          >
            {r.map((v, i) => cell(v, i, `${ri}-${i}`))}
          </View>
        ))}
        <Text
          style={s.foot}
          fixed
          render={({ pageNumber, totalPages }) => `${meta.madeAt} · ${pageNumber} / ${totalPages}`}
        />
      </Page>
    </Document>
  );
}

export async function toPdf(table: ReportTable, meta: ExportMeta): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(<ReportPdf table={table} meta={meta} />));
}
