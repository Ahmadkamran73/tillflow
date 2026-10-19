"use client";

import { useEffect, useRef } from "react";

/**
 * A result that arrives with the page (saved, limit reached, bad dates): a live region that is
 * already filled when the page loads is not announced, so focus moves to it once when it shows.
 */
export function FocusMessage({
  message,
  urgent,
  id,
}: {
  message: string;
  urgent: boolean;
  id?: string;
}) {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (message) ref.current?.focus();
  }, [message]);
  return (
    <p
      ref={ref}
      id={id}
      role={urgent ? "alert" : "status"}
      tabIndex={-1}
      className={`text-sm font-medium outline-none empty:hidden ${urgent ? "text-destructive" : ""}`}
    >
      {message}
    </p>
  );
}
