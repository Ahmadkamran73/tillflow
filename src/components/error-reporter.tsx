"use client";

import { useEffect } from "react";
import { reportBrowserError } from "@/lib/errors/report-browser-error";

/** Mounted once in the root layout: reports uncaught browser errors and rejected promises. */
export function ErrorReporter() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => reportBrowserError(event.error ?? event.message);
    const onRejection = (event: PromiseRejectionEvent) => reportBrowserError(event.reason);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
