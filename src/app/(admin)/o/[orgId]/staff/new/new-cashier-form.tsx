"use client";

import { useActionState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addTillStaffAction, type AddStaffState } from "@/lib/device/admin-actions";
import { t, type MessageKey } from "@/lib/i18n";
import { PinFields } from "../pin-fields";

const messages: Record<NonNullable<AddStaffState["error"]>, MessageKey> = {
  invalid: "staff.invalid",
  mismatch: "staff.mismatch",
  nameInUse: "staff.nameInUse",
  error: "staff.error",
};

/** Add cashier. Keeps the typed name after an error and moves focus to the field to fix. */
export function NewCashierForm({ orgId }: { orgId: string }) {
  const [state, action, pending] = useActionState(addTillStaffAction, { name: "" });
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!state.error) return;
    const target = state.field
      ? formRef.current?.querySelector<HTMLElement>(`#${state.field}`)
      : null;
    (target ?? document.getElementById("staff-error"))?.focus();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-4">
      {state.error && (
        <p id="staff-error" role="alert" tabIndex={-1} className="text-destructive text-sm">
          {t(messages[state.error])}
        </p>
      )}
      <input type="hidden" name="orgId" value={orgId} />
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("staff.nameLabel")}
        <Input
          name="name"
          id="name"
          required
          maxLength={40}
          autoComplete="off"
          defaultValue={state.name}
          key={state.name}
          aria-invalid={state.field === "name" || undefined}
          aria-describedby={state.field === "name" ? "staff-error" : undefined}
          className="h-12"
        />
      </label>
      <PinFields
        invalid={state.field === "pin" || state.field === "confirm" ? state.field : undefined}
        errorId="staff-error"
      />
      <Button type="submit" className="h-12 self-start px-5" disabled={pending}>
        {t("staff.save")}
      </Button>
    </form>
  );
}
