"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { canApprove, type PinResult, type StaffMember } from "@/lib/register/staff";
import { Cancel, Modal } from "./dialogs";
import { PinEntry } from "./pin-entry";

/**
 * A manager or owner approves one action (a discount above the shop's limit, the drawer opened
 * with no sale) by picking their name and entering their PIN. Everyone asking is the cashier; the
 * approval is the manager's own PIN, so it cannot be given by someone who only knows a cashier PIN.
 */
export function OverrideDialog({
  reason,
  staff,
  offline,
  verify,
  onApproved,
  onClose,
}: {
  /** What needs approving, in words. */
  reason: string;
  staff: StaffMember[];
  offline: boolean;
  verify: (member: StaffMember, pin: string) => Promise<PinResult>;
  onApproved: (approval: { userId: string; name: string; approvalId?: string }) => void;
  onClose: () => void;
}) {
  const [picked, setPicked] = useState<StaffMember | null>(null);
  const managers = staff
    .filter((m) => canApprove(m.role))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <Modal title={t("override.title")} description={reason} onClose={onClose}>
      {picked ? (
        <PinEntry
          member={picked}
          offline={offline}
          submitLabel={t("override.approve")}
          verify={(pin) => verify(picked, pin)}
          onBack={() => setPicked(null)}
          onOk={({ userId, approvalId }) =>
            onApproved({ userId, name: picked.displayName, approvalId })
          }
        />
      ) : (
        <>
          {managers.length === 0 ? (
            <p role="status">{t("override.noManagers")}</p>
          ) : (
            <ul className="flex max-h-[50dvh] flex-col gap-2 overflow-y-auto">
              {managers.map((m) => (
                <li key={m.userId}>
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    className="w-full justify-between"
                    onClick={() => setPicked(m)}
                  >
                    <span>
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
          )}
          <Cancel onClick={onClose} />
        </>
      )}
    </Modal>
  );
}
