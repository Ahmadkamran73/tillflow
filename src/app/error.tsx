"use client";

import { useEffect } from "react";
import { reportBrowserError } from "@/lib/errors/report-browser-error";

/** Error boundary for every page under the root layout. Reports the error, never shows it. */
export default function Error({
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
    <main className="mx-auto flex max-w-md flex-1 flex-col justify-center gap-4 p-6">
      <h1 className="text-xl font-semibold">Something went wrong</h1>
      <p>The problem has been logged. Please try again.</p>
      <button
        type="button"
        onClick={() => retry()}
        className="min-h-12 rounded-md border px-4 font-medium"
      >
        Try again
      </button>
    </main>
  );
}
