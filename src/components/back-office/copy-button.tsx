"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";

/**
 * Copies a value (a payment reference, an IBAN). The result is announced in a status region that
 * is always on the page; the button keeps a visible label and names what it copies.
 */
export function CopyButton({ value, what }: { value: string; what: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function copy() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(value);
      ok = true;
    } catch {
      ok = false;
    }
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    // A failure stays until the next press; only the confirmation fades.
    if (ok) timer.current = setTimeout(() => setState("idle"), 4000);
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        className="h-12 px-4"
        onClick={() => void copy()}
        aria-label={t("billing.copyLabel", { what })}
      >
        {state === "copied" ? (
          <CheckIcon aria-hidden className="size-4" />
        ) : (
          <CopyIcon aria-hidden className="size-4" />
        )}
        {t("billing.copy")}
      </Button>
      <span role="status" aria-live="polite" aria-atomic="true" className="inline-block min-w-16 text-sm font-medium">
        {state === "copied"
          ? t("billing.copied")
          : state === "failed"
            ? t("billing.copyFailed")
            : ""}
      </span>
    </span>
  );
}
