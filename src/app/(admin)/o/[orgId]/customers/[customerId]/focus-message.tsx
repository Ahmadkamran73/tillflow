"use client";

import { useEffect, useRef } from "react";

/**
 * The result of a save, erase or download limit arrives with the page, so a screen reader would not
 * announce an already-filled live region: move focus to it once when it is shown.
 */
export function FocusMessage({ message, urgent }: { message: string; urgent: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  return (
    <p
      ref={ref}
      role={urgent ? "alert" : "status"}
      tabIndex={-1}
      className="text-sm font-medium outline-none empty:hidden"
    >
      {message}
    </p>
  );
}
