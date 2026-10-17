import "server-only";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { formatCents } from "@/lib/money";
import type { BillingConfig } from "./config";
import { formatIban } from "./config";
import { invoiceFileName, invoiceNumber } from "./invoice-number";
import { addDays, irishDate } from "./period";

export { irishDate };

/**
 * Our invoice to a shop. Everything on it is read from the stored invoice row (amounts, rate,
 * number, reference, dates) and from the billing settings (our name, VAT number, bank details):
 * nothing is recalculated here, so a reprint always matches what was issued.
 */
export type InvoiceView = {
  invoiceNo: number;
  issuedOn: string; // YYYY-MM-DD, Irish date
  dueOn: string;
  periodStart: string;
  periodEnd: string; // exclusive
  amountExVatCents: number;
  vatRateBp: number;
  vatCents: number;
  totalCents: number;
  paymentReference: string;
  /** Supplier and customer exactly as they were when the invoice was issued (stored on the row). */
  supplierName: string;
  supplierAddress: string;
  supplierVatNumber: string;
  customerName: string;
  customerAddress: string | null;
  customerVatNumber: string | null;
  paid: boolean;
};

export { invoiceFileName, invoiceNumber };
const rateText = (bp: number) => `${(bp / 100).toFixed(bp % 100 === 0 ? 0 : 1)}%`;

const TEXT = {
  invoice: "Invoice",
  number: "Invoice number",
  issued: "Date",
  due: "Due",
  billTo: "Bill to",
  vatNo: "VAT number",
  description: "Description",
  exVat: "Amount ex VAT",
  vat: "VAT",
  total: "Total",
  line: "Tillflow POS subscription",
  payHeading: "How to pay",
  payIntro:
    "Please pay by bank transfer (SEPA credit transfer). Quote the payment reference exactly so we can match your payment.",
  account: "Account name",
  iban: "IBAN",
  bic: "BIC",
  reference: "Payment reference",
  amount: "Amount to pay",
  paid: "Paid. Thank you.",
  footer: "Prices are in euro. VAT is shown at the rate in force when the invoice was issued.",
} as const;

const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, fontFamily: "Helvetica", color: "#111111" },
  top: { flexDirection: "row", justifyContent: "space-between" },
  brand: { fontSize: 18, fontFamily: "Helvetica-Bold" },
  small: { fontSize: 9, color: "#444444", marginTop: 2 },
  title: { fontSize: 22, fontFamily: "Helvetica-Bold", textAlign: "right" },
  meta: { marginTop: 22, flexDirection: "row", justifyContent: "space-between" },
  label: { fontSize: 8, color: "#555555", textTransform: "uppercase", marginBottom: 2 },
  bold: { fontFamily: "Helvetica-Bold" },
  table: { marginTop: 24 },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#bbbbbb",
    paddingVertical: 5,
  },
  head: { borderBottomWidth: 1, borderBottomColor: "#111111", fontFamily: "Helvetica-Bold" },
  desc: { flex: 3 },
  num: { flex: 1.2, textAlign: "right" },
  totals: { marginTop: 8, alignSelf: "flex-end", width: "45%" },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  grand: {
    borderTopWidth: 1,
    borderTopColor: "#111111",
    marginTop: 3,
    paddingTop: 4,
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
  },
  pay: { marginTop: 28, padding: 12, borderWidth: 1, borderColor: "#111111" },
  payRow: { flexDirection: "row", marginTop: 3 },
  payKey: { width: 110, color: "#444444" },
  paidNote: { marginTop: 10, fontFamily: "Helvetica-Bold" },
  foot: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#666666" },
});

function InvoicePdf({ inv, config }: { inv: InvoiceView; config: BillingConfig }) {
  const lastDay = addDays(inv.periodEnd, -1);
  return (
    <Document title={`${TEXT.invoice} ${invoiceNumber(inv.invoiceNo)}`} author="Tillflow">
      <Page size="A4" style={s.page}>
        <View style={s.top}>
          <View>
            <Text style={s.brand}>{inv.supplierName}</Text>
            <Text style={s.small}>{inv.supplierAddress}</Text>
            <Text style={s.small}>
              {TEXT.vatNo}: {inv.supplierVatNumber}
            </Text>
          </View>
          <Text style={s.title}>{TEXT.invoice}</Text>
        </View>

        <View style={s.meta}>
          <View>
            <Text style={s.label}>{TEXT.billTo}</Text>
            <Text style={s.bold}>{inv.customerName}</Text>
            {inv.customerAddress ? <Text style={s.small}>{inv.customerAddress}</Text> : null}
            {inv.customerVatNumber ? (
              <Text style={s.small}>
                {TEXT.vatNo}: {inv.customerVatNumber}
              </Text>
            ) : null}
          </View>
          <View>
            <Text style={s.label}>{TEXT.number}</Text>
            <Text style={s.bold}>{invoiceNumber(inv.invoiceNo)}</Text>
            <Text style={[s.label, { marginTop: 6 }]}>{TEXT.issued}</Text>
            <Text>{irishDate(inv.issuedOn)}</Text>
            <Text style={[s.label, { marginTop: 6 }]}>{TEXT.due}</Text>
            <Text>{irishDate(inv.dueOn)}</Text>
          </View>
        </View>

        <View style={s.table}>
          <View style={[s.row, s.head]}>
            <Text style={s.desc}>{TEXT.description}</Text>
            <Text style={s.num}>{TEXT.exVat}</Text>
            <Text style={s.num}>{`${TEXT.vat} ${rateText(inv.vatRateBp)}`}</Text>
            <Text style={s.num}>{TEXT.total}</Text>
          </View>
          <View style={s.row}>
            <Text style={s.desc}>
              {`${TEXT.line}, ${irishDate(inv.periodStart)} to ${irishDate(lastDay)}`}
            </Text>
            <Text style={s.num}>{formatCents(inv.amountExVatCents)}</Text>
            <Text style={s.num}>{formatCents(inv.vatCents)}</Text>
            <Text style={s.num}>{formatCents(inv.totalCents)}</Text>
          </View>
        </View>

        <View style={s.totals}>
          <View style={s.totalRow}>
            <Text>{TEXT.exVat}</Text>
            <Text>{formatCents(inv.amountExVatCents)}</Text>
          </View>
          <View style={s.totalRow}>
            <Text>{`${TEXT.vat} ${rateText(inv.vatRateBp)}`}</Text>
            <Text>{formatCents(inv.vatCents)}</Text>
          </View>
          <View style={[s.totalRow, s.grand]}>
            <Text>{TEXT.total}</Text>
            <Text>{formatCents(inv.totalCents)}</Text>
          </View>
        </View>

        <View style={s.pay} wrap={false}>
          <Text style={s.bold}>{TEXT.payHeading}</Text>
          <Text style={s.small}>{TEXT.payIntro}</Text>
          {(
            [
              [TEXT.account, config.accountName],
              [TEXT.iban, formatIban(config.iban)],
              [TEXT.bic, config.bic],
              [TEXT.reference, inv.paymentReference],
              [TEXT.amount, formatCents(inv.totalCents)],
            ] as const
          ).map(([k, v]) => (
            <View key={k} style={s.payRow}>
              <Text style={s.payKey}>{k}</Text>
              <Text style={s.bold}>{v}</Text>
            </View>
          ))}
          {inv.paid ? <Text style={s.paidNote}>{TEXT.paid}</Text> : null}
        </View>

        <Text style={s.foot} fixed>
          {TEXT.footer}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(inv: InvoiceView, config: BillingConfig): Promise<Buffer> {
  return Buffer.from(await renderToBuffer(<InvoicePdf inv={inv} config={config} />));
}
