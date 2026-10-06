"use client";

import { CheckIcon, MinusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createPairingCodeAction, revokeRegisterAction } from "@/lib/device/admin-actions";
import { t } from "@/lib/i18n";

export type TillRow = { id: string; name: string; paired: boolean; lastSeen: string | null };

type Open =
  | null
  | { kind: "code"; name: string; code: string; expiresAt: string }
  | { kind: "revoke"; id: string; name: string };

export function TillsManager({ orgId, tills }: { orgId: string; tills: TillRow[] }) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const [message, setMessage] = useState("");
  const [pending, start] = useTransition();
  const status = useRef<HTMLParagraphElement>(null);

  const pair = (till: TillRow) =>
    start(async () => {
      setMessage("");
      const r = await createPairingCodeAction(orgId, till.id);
      if (r.ok) setOpen({ kind: "code", name: till.name, code: r.code, expiresAt: r.expiresAt });
      else setMessage(t("tills.error"));
      router.refresh();
    });

  const revoke = (id: string, name: string) =>
    start(async () => {
      const r = await revokeRegisterAction(orgId, id);
      setOpen(null);
      setMessage(r.ok ? t("tills.revoked", { name }) : t("tills.error"));
      router.refresh();
      // The Revoke button is gone once the till is unpaired: put focus on the result instead.
      requestAnimationFrame(() => status.current?.focus());
    });

  if (tills.length === 0) return <p>{t("tills.empty")}</p>;

  return (
    <>
      <p ref={status} role="status" tabIndex={-1} className="min-h-5 text-sm outline-offset-4">
        {message}
      </p>
      <ul className="surface-panel divide-border divide-y">
        {tills.map((till) => (
          <li key={till.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
            <div className="flex min-w-40 flex-1 flex-col">
              <span className="font-medium">{till.name}</span>
              <span className="text-muted-foreground text-sm">
                {till.paired ? (
                  <CheckIcon aria-hidden className="inline size-4" />
                ) : (
                  <MinusIcon aria-hidden className="inline size-4" />
                )}{" "}
                {till.paired ? t("tills.paired") : t("tills.notPaired")} ·{" "}
                {till.lastSeen
                  ? t("tills.lastSeen", { when: till.lastSeen })
                  : t("tills.neverSeen")}
              </span>
            </div>
            <Button
              variant="outline"
              className="h-12"
              disabled={pending}
              aria-label={`${till.paired ? t("tills.pairAgain") : t("tills.pair")} ${till.name}`}
              onClick={() => pair(till)}
            >
              {till.paired ? t("tills.pairAgain") : t("tills.pair")}
            </Button>
            {till.paired && (
              <Button
                variant="outline"
                className="h-12"
                disabled={pending}
                aria-label={t("tills.revokeFor", { name: till.name })}
                onClick={() => setOpen({ kind: "revoke", id: till.id, name: till.name })}
              >
                {t("tills.revoke")}
              </Button>
            )}
          </li>
        ))}
      </ul>

      <Dialog open={open?.kind === "code"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          {open?.kind === "code" && (
            <>
              <DialogHeader>
                <DialogTitle>{t("tills.codeTitle", { name: open.name })}</DialogTitle>
                <DialogDescription>
                  {t("tills.codeBody", {
                    time: new Date(open.expiresAt).toLocaleTimeString("en-IE", {
                      hour: "2-digit",
                      minute: "2-digit",
                    }),
                  })}
                </DialogDescription>
              </DialogHeader>
              <p className="bg-muted rounded-lg p-4 text-center font-mono text-3xl tracking-widest">
                <span aria-hidden>{open.code}</span>
                <span className="sr-only">{open.code.replace("-", " ").split("").join(", ")}</span>
              </p>
              <DialogFooter>
                <Button className="h-12" onClick={() => setOpen(null)}>
                  {t("tills.done")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={open?.kind === "revoke"} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent>
          {open?.kind === "revoke" && (
            <>
              <DialogHeader>
                <DialogTitle>{t("tills.revokeFor", { name: open.name })}</DialogTitle>
                <DialogDescription>
                  {t("tills.revokeConfirm", { name: open.name })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" className="h-12" onClick={() => setOpen(null)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  className="h-12"
                  disabled={pending}
                  onClick={() => revoke(open.id, open.name)}
                >
                  {t("tills.revokeYes")}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
