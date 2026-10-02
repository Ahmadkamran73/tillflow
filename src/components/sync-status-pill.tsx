import { CloudOffIcon, RefreshCwIcon, WifiIcon } from "lucide-react";
import { cn } from "cn";
import { t } from "@/lib/i18n";

export type SyncState = "online" | "offline" | "syncing";

const styles = {
  online: { Icon: WifiIcon, cls: "bg-success text-success-foreground" },
  offline: { Icon: CloudOffIcon, cls: "bg-warning text-warning-foreground" },
  syncing: { Icon: RefreshCwIcon, cls: "bg-info text-info-foreground" },
} as const;

/** Solid fill + icon + text: colour is never the only signal. Announced politely when it changes. */
export function SyncStatusPill({
  state,
  waiting = 0,
  className,
}: {
  state: SyncState;
  waiting?: number;
  className?: string;
}) {
  const { Icon, cls } = styles[state];
  return (
    <p
      role="status"
      className={cn(
        "inline-flex min-h-10 items-center gap-2 rounded-full px-4 text-sm font-semibold",
        cls,
        className,
      )}
    >
      <Icon
        aria-hidden
        className={cn("size-4", state === "syncing" && "motion-safe:animate-spin")}
      />
      {t(`sync.${state}`, { count: waiting })}
    </p>
  );
}
