"use client";

import { LockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import type { PinResult, Role, StaffMember } from "@/lib/register/staff";
import { PinEntry } from "./pin-entry";

export type Cashier = { userId: string; name: string; role: Role };

/**
 * Shown instead of the till whenever nobody is signed in to it: first load, the Lock button, and
 * after a few minutes without a touch. Pick your name, enter your PIN. The till stays usable
 * offline because the PINs are checked against hashes saved on the device.
 */
export function LockScreen({
  staff,
  ready,
  offline,
  verify,
  onUnlock,
}: {
  staff: StaffMember[];
  /** False until the shop's staff list has been loaded at least once. */
  ready: boolean;
  offline: boolean;
  verify: (member: StaffMember, pin: string) => Promise<PinResult>;
  onUnlock: (cashier: Cashier) => void;
}) {
  const [picked, setPicked] = useState<StaffMember | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus lands on the heading when the screen appears and when someone steps back to the list.
  useEffect(() => {
    if (!picked) heading.current?.focus();
  }, [picked]);
  const people = [...staff].sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <main className="surface-solid bg-background text-foreground flex min-h-dvh flex-col items-center justify-center gap-6 p-6">
      <div className="flex w-full max-w-md flex-col gap-4">
        <h1
          ref={heading}
          tabIndex={-1}
          className="text-heading flex items-center gap-2 font-semibold outline-offset-4"
        >
          <LockIcon aria-hidden /> {t("lock.title")}
        </h1>
        {picked ? (
          <PinEntry
            member={picked}
            offline={offline}
            submitLabel={t("lock.unlock")}
            verify={(pin) => verify(picked, pin)}
            onBack={() => setPicked(null)}
            onOk={({ userId, role }) => onUnlock({ userId, role, name: picked.displayName })}
          />
        ) : !ready ? (
          <p role="status">{t("register.loading")}</p>
        ) : people.length === 0 ? (
          <p role="status">{t("lock.noStaff")}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{t("lock.pickHint")}</p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {people.map((m) => (
                <li key={m.userId}>
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    className="h-16 w-full flex-col items-start gap-0 text-left"
                    onClick={() => setPicked(m)}
                  >
                    <span className="font-semibold">
                      {m.displayName}
                      <span className="sr-only">,</span>
                    </span>
                    <span className="text-muted-foreground text-xs font-normal">
                      {t(`lock.role.${m.role}`)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </main>
  );
}
