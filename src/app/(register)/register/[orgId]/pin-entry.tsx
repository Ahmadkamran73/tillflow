"use client";

import { DeleteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import type { PinResult, StaffMember } from "@/lib/register/staff";

const MAX_DIGITS = 6;
const MIN_DIGITS = 4;

/** The words for each way a PIN check can end badly. */
export function pinProblem(r: Exclude<PinResult, { status: "ok" }>): string {
  switch (r.status) {
    case "invalid":
      return t("lock.invalid");
    case "locked":
      return t("lock.locked", {
        time: new Date(r.lockedUntil).toLocaleTimeString("en-IE", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      });
    case "limited":
      return t("lock.limited");
    case "unpaired":
      return t("lock.unpaired");
    case "not_allowed":
      return t("override.notAllowed");
  }
}

/**
 * One person's PIN. A real password field (so a hardware keyboard and screen readers work, and the
 * on-screen keyboard stays away: `inputMode="none"`) plus a large number pad for touch. The PIN
 * lives only in this component's state and is cleared after every try.
 */
export function PinEntry({
  member,
  verify,
  onOk,
  onBack,
  submitLabel,
  offline,
}: {
  member: StaffMember;
  verify: (pin: string) => Promise<PinResult>;
  onOk: (result: Extract<PinResult, { status: "ok" }>) => void;
  onBack: () => void;
  submitLabel: string;
  /** True when the till cannot reach the server, so the check uses the PIN saved on the till. */
  offline: boolean;
}) {
  const [pin, setPin] = useState("");
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const set = (value: string) => {
    setPin(value.replace(/\D/g, "").slice(0, MAX_DIGITS));
    setProblem("");
  };

  async function submit() {
    if (busy || pin.length < MIN_DIGITS) return;
    setBusy(true);
    const result = await verify(pin);
    setBusy(false);
    setPin("");
    if (result.status === "ok") return onOk(result);
    setProblem(pinProblem(result));
    input.current?.focus();
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("lock.enterPin", { name: member.displayName })}
        <Input
          ref={input}
          type="password"
          inputMode="none"
          autoComplete="off"
          maxLength={MAX_DIGITS}
          value={pin}
          aria-invalid={problem !== ""}
          aria-describedby={problem ? "pin-hint pin-problem" : "pin-hint"}
          className="h-14 text-center font-mono text-2xl tracking-[0.5em]"
          onChange={(e) => set(e.target.value)}
        />
      </label>
      <p id="pin-hint" className="text-muted-foreground text-sm">
        {t("lock.pinHint")}
      </p>
      <p aria-live="polite" className="sr-only">
        {problem ? "" : t("lock.digitsEntered", { count: pin.length })}
      </p>
      {offline && <p className="text-muted-foreground text-sm">{t("lock.offlineHint")}</p>}
      <p id="pin-problem" role="alert" className="text-destructive min-h-5 text-sm font-medium">
        {problem}
      </p>
      <div role="group" aria-label={t("lock.pad")} className="grid grid-cols-3 gap-2">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <Button
            key={d}
            type="button"
            variant="outline"
            className="h-14 text-xl"
            disabled={busy}
            onClick={() => set(pin + d)}
          >
            {d}
          </Button>
        ))}
        <Button type="button" variant="outline" className="h-14" onClick={onBack} disabled={busy}>
          {t("lock.back")}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-14 text-xl"
          disabled={busy}
          onClick={() => set(pin + "0")}
        >
          0
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-14"
          aria-label={t("lock.delete")}
          disabled={busy || pin.length === 0}
          onClick={() => set(pin.slice(0, -1))}
        >
          <DeleteIcon aria-hidden />
        </Button>
      </div>
      <Button type="submit" size="pay" disabled={busy || pin.length < MIN_DIGITS}>
        {busy ? t("lock.checking") : submitLabel}
      </Button>
    </form>
  );
}
