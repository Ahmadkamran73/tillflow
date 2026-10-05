"use client";

import { useEffect } from "react";

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
      {job?.lines.join("\n")}
    </pre>
  );
}
