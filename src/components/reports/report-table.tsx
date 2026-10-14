import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { t } from "@/lib/i18n";
import { showCell, type ReportTable } from "@/lib/reports/table";

/** A report as a real table: column and row headers, keyboard-scrollable on a narrow screen. */
export function ReportTableView({ table }: { table: ReportTable }) {
  const title = t(table.title);
  return (
    <div
      className="surface-panel overflow-x-auto [&>div]:overflow-visible"
      role="region"
      tabIndex={0}
      aria-label={title}
      data-testid="report-table"
    >
      <Table>
        <TableHeader>
          <TableRow>
            {table.columns.map((c, i) => (
              <TableHead
                key={i}
                scope="col"
                className={c.kind === "text" ? undefined : "text-right"}
              >
                {t(c.label)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row, ri) => (
            <TableRow key={ri}>
              {row.map((v, i) =>
                i === 0 ? (
                  <TableHead key={i} scope="row" className="font-medium">
                    {showCell(table.columns[i]!.kind, v)}
                  </TableHead>
                ) : (
                  <TableCell
                    key={i}
                    className={
                      table.columns[i]!.kind === "text"
                        ? undefined
                        : "text-right font-mono tabular-nums"
                    }
                  >
                    {showCell(table.columns[i]!.kind, v)}
                  </TableCell>
                ),
              )}
            </TableRow>
          ))}
        </TableBody>
        {table.totals ? (
          <TableFooter>
            <TableRow>
              {table.totals.map((v, i) =>
                i === 0 ? (
                  <TableHead key={i} scope="row" className="font-semibold">
                    {showCell(table.columns[i]!.kind, v)}
                  </TableHead>
                ) : (
                  <TableCell
                    key={i}
                    className={
                      table.columns[i]!.kind === "text"
                        ? undefined
                        : "text-right font-mono font-semibold tabular-nums"
                    }
                  >
                    {v === "" ? "" : showCell(table.columns[i]!.kind, v)}
                  </TableCell>
                ),
              )}
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
    </div>
  );
}
