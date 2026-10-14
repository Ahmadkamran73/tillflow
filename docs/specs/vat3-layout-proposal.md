# VAT report layout: proposal for the accountant

**Status: AWAITING ACCOUNTANT RESPONSE. No confirmation has been received or recorded.** Nothing in
this file may be read as approval. When the accountant answers, fill in "Response" below with their
name, date and wording, and only then change the status.

Report: Reports > VAT by rate (`/o/<shop>/reports/vat`), also downloadable as CSV, Excel and PDF.
For any date range (quick buttons: this and last two-month VAT period, this and last month).

## What the report shows, per VAT rate

| Column | Meaning | Source |
| --- | --- | --- |
| VAT rate | the rate stored on each sale line when it was sold (23%, 13.5%, 9%, 4.8%, 0%) | sale line snapshot |
| Net (ex VAT) | sales before VAT at that rate | sum of stored line net |
| Sales VAT | VAT charged on those sales | sum of stored line VAT |
| Gross (excl. deposits, tips, rounding) | sales including VAT, excluding Re-turn deposits, tips and 5c cash rounding | sum of stored line gross |
| Refund net / Refund VAT / Refund gross | goods returned, at the ORIGINAL sale rate, counted on the day the refund was given | refund line snapshot |
| Net VAT due (sales less refunds) | Sales VAT minus Refund VAT | subtraction only |

A Total row adds each column. Sales VAT, Refund VAT and Net VAT due are always separate columns.
Every figure is a sum of cents already stored on the sale and refund lines: nothing is recalculated.

### Example (as it prints)

| VAT rate | Net | Sales VAT | Gross | Refund net | Refund VAT | Refund gross | Net VAT due |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 23% | 12,345.67 | 2,839.50 | 15,185.17 | 100.00 | 23.00 | 123.00 | 2,816.50 |
| 13.5% | 880.00 | 118.80 | 998.80 | 0.00 | 0.00 | 0.00 | 118.80 |
| 9% | 4,500.00 | 405.00 | 4,905.00 | 5,000.00 | 450.00 | 5,450.00 | -45.00 |
| 0% | 123.45 | 0.00 | 123.45 | 0.00 | 0.00 | 0.00 | 0.00 |
| Total | 17,849.12 | 3,363.30 | 21,212.42 | 5,100.00 | 473.00 | 5,573.00 | 2,890.30 |

(Sample data. The 9% row shows a negative VAT due because more was refunded in the period than sold.)

## Questions for the accountant

1. **Refund dating.** Refunds are counted in the period they are given, not the period of the sale
   (like a credit note issued in that period). Is that the treatment you want for the VAT3?
2. **Layout.** Is "Sales VAT, Refund VAT, Net VAT due" per rate, plus a total, the right working
   layout for the VAT3 (T1 sales VAT)? Do you need the net sales (ex VAT) total on its own line, or
   different columns?
3. **Service charge (restaurants).** It is added as ordinary lines taxed at each item's own rate and
   appears in the rate rows. Is that the right VAT treatment for the shops you act for?
4. **Deposits (Re-turn), tips and 5c cash rounding.** They are outside VAT and left out of the
   table, so its gross is lower than the takings in Payments. Is the note on the report enough, or
   should the report show them as separate memo lines?
5. **Rates.** 4.8% (livestock) and 13.5% appear when used; 23/13.5/9/0 after 1 July 2026 as in
   PLAN.md section 12. Any Budget 2027 changes before go-live?
6. **Period.** The quick ranges are the bi-monthly VAT periods (Jan-Feb ... Nov-Dec). Shops on
   4-monthly, 6-monthly or annual returns can type any dates. Do you want a per-shop VAT period
   setting?
7. **Eat-in / take-away.** The rate is whatever was stored on the line at sale time (a shop sets it
   per product). Please also confirm the rate for hot take-away food (open item in STATUS.md).

## Response

| Field | Value |
| --- | --- |
| Accountant (name, firm) | _not yet received_ |
| Date | _not yet received_ |
| Answers to questions 1-7 | _not yet received_ |
| Layout approved as proposed | **NO RESPONSE YET** |
| Changes requested | _none recorded_ |
