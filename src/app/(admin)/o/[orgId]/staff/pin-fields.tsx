import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";

/**
 * PIN and repeat, as on My till PIN. Shared by Add cashier and Manage. `invalid` marks the field
 * to fix and ties it to the error message `errorId`.
 */
export function PinFields({ invalid, errorId }: { invalid?: "pin" | "confirm"; errorId?: string }) {
  const pin = {
    type: "password",
    inputMode: "numeric",
    required: true,
    minLength: 4,
    maxLength: 6,
    pattern: "[0-9]{4,6}",
    title: t("staff.pinHint"),
    // Not "off": browsers ignore that on password fields and would fill in the manager's login.
    autoComplete: "new-password",
    className: "h-12",
  } as const;
  const describedBy = (field: "pin" | "confirm") =>
    [field === "pin" ? "pin-hint" : null, invalid === field ? errorId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("staff.pinLabel")}
        <Input
          name="pin"
          id="pin"
          aria-invalid={invalid === "pin" || undefined}
          aria-describedby={describedBy("pin")}
          {...pin}
        />
        <span id="pin-hint" className="text-muted-foreground text-sm font-normal">
          {t("staff.pinHint")}
        </span>
      </label>
      <label className="flex flex-col gap-1 text-sm font-medium">
        {t("staff.confirmLabel")}
        <Input
          name="confirm"
          id="confirm"
          aria-invalid={invalid === "confirm" || undefined}
          aria-describedby={describedBy("confirm")}
          {...pin}
        />
      </label>
    </>
  );
}
