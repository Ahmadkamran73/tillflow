"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

/** The till types the one-time code a manager made; the server answers with a cookie, not a token. */
export function PairForm() {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/v1/register/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ code: code.replace(/[\s-]/g, "").toUpperCase() }),
      });
      const body = (await res.json().catch(() => null)) as {
        orgId?: string;
        error?: string;
      } | null;
      if (res.ok && body?.orgId) {
        router.push(`/register/${body.orgId}`);
        router.refresh();
        return;
      }
      setError(res.status === 400 ? t("pair.invalid") : (body?.error ?? t("pair.network")));
    } catch {
      setError(t("pair.network"));
    }
    setBusy(false);
    input.current?.focus();
  }

  return (
    <main className="surface-solid bg-background text-foreground flex min-h-dvh items-center justify-center p-6">
      <form
        className="flex w-full max-w-md flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h1 className="text-heading font-semibold">{t("pair.title")}</h1>
        <p className="text-muted-foreground">{t("pair.body")}</p>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("pair.code")}
          <Input
            ref={input}
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            maxLength={12}
            value={code}
            aria-invalid={error !== ""}
            aria-describedby={error ? "pair-hint pair-error" : "pair-hint"}
            className="h-14 text-center font-mono text-2xl tracking-widest uppercase"
            onChange={(e) => {
              setCode(e.target.value);
              setError("");
            }}
          />
        </label>
        <p id="pair-hint" className="text-muted-foreground text-sm">
          {t("pair.codeHint")}
        </p>
        <p id="pair-error" role="alert" className="text-destructive min-h-5 text-sm font-medium">
          {error}
        </p>
        <Button type="submit" size="pay" disabled={busy || code.replace(/[\s-]/g, "").length < 8}>
          {busy ? t("pair.working") : t("pair.submit")}
        </Button>
      </form>
    </main>
  );
}
