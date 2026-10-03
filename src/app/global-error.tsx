"use client";

import { useEffect } from "react";
import { reportBrowserError } from "@/lib/errors/report-browser-error";

/** Last-resort error screen (replaces the root layout). The error is reported, never shown. */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    reportBrowserError(error, error.digest);
  }, [error]);

  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
        <main>
          <h1>Something went wrong</h1>
          <p>The problem has been logged. Please try again.</p>
          <button type="button" onClick={() => retry()} style={{ minHeight: 48, minWidth: 48 }}>
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
