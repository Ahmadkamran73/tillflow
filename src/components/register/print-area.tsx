"use client";

import { useEffect } from "react";
import { BARCODE_MARK } from "@/lib/register/print/escpos";

/** The receipt as plain text, visible only when printing; opens the browser print window once per `job`. */
export function PrintArea({
  job,
  cols,
}: {
  job: { n: number; lines: string[] } | null;
  cols: number;
}) {
  useEffect(() => {
    if (job) window.print();
  }, [job]);
  return (
    <pre id="print-receipt" className="print-only" style={{ width: `${cols}ch` }} aria-hidden>
      {job?.lines
        .map((l) => (l.startsWith(BARCODE_MARK) ? l.slice(BARCODE_MARK.length) : l))
        .join("\n")}
    </pre>
  );
}
