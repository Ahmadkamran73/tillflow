"use client";

import { MailIcon, PrinterIcon, ReceiptTextIcon } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { formatCents } from "@/lib/money";
import { invoiceInput, type InvoiceInput } from "@/lib/register/invoice";
import type { PrinterSettings } from "@/lib/register/print";
import { LOCAL_BRIDGE } from "@/lib/register/print/bridge";
import { chooseUsbPrinter, usbSupported } from "@/lib/register/print/usb";
import { Cancel, Modal } from "./dialogs";

export function DoneDialog({
  change,
  status,
  invoiceIssued,
  onPrint,
  onEmail,
  onInvoice,
  onNewSale,
}: {
  change: number;
  status: string;
  invoiceIssued: boolean;
  onPrint: () => void;
  onEmail: () => void;
  onInvoice: () => void;
  onNewSale: () => void;
}) {
  return (
    <Modal title={t("register.complete")} onClose={() => {}}>
      <p role="status" className="text-heading font-semibold tabular-nums">
        {t("register.change", { amount: formatCents(change) })}
      </p>
      <p role="status" className="text-muted-foreground text-sm">
        {status}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Button type="button" size="touch" variant="outline" onClick={onPrint}>
          <PrinterIcon aria-hidden /> {t("register.printAgain")}
        </Button>
        <Button type="button" size="touch" variant="outline" onClick={onEmail}>
          <MailIcon aria-hidden /> {t("register.emailReceipt")}
        </Button>
        <Button type="button" size="touch" variant="outline" onClick={onInvoice}>
          <ReceiptTextIcon aria-hidden /> {t("register.vatInvoice")}
          {invoiceIssued ? ` (${t("register.invoiceIssued")})` : ""}
        </Button>
      </div>
      <Button type="button" size="pay" autoFocus onClick={onNewSale}>
        {t("register.newSale")}
      </Button>
    </Modal>
  );
}

/** Moves focus to the first field the person has to fix. */
function focusInvalid(root: HTMLElement | null) {
  root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
}

/** A labelled input whose hint and error are tied to it, for screen readers and keyboard users. */
function TextField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  required,
  type = "text",
  autoFocus,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  error?: string;
  required?: boolean;
  type?: string;
  autoFocus?: boolean;
}) {
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(" ");
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        <span className="text-muted-foreground font-normal">
          {" "}
          {required ? t("register.required") : t("register.optional")}
        </span>
      </label>
      <Input
        id={id}
        type={type}
        autoFocus={autoFocus}
        autoComplete="off"
        value={value}
        required={required}
        aria-required={required}
        aria-invalid={!!error}
        aria-describedby={describedBy || undefined}
        className="h-12 text-base md:text-base"
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs">
          {t("register.example", { example: hint })}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

const HOST = /^[A-Za-z0-9.-]+:\d{2,5}$/;
const selectClass = "border-input bg-background h-12 rounded-md border-2 px-3 text-base";

export function PrinterDialog({
  value,
  onSave,
  onTest,
  onClose,
}: {
  value: PrinterSettings;
  onSave: (p: PrinterSettings) => void;
  onTest: (p: PrinterSettings) => void;
  onClose: () => void;
}) {
  const [p, setP] = useState<PrinterSettings>(value);
  const [errors, setErrors] = useState<{ bridgeUrl?: string; host?: string }>({});
  const [usbError, setUsbError] = useState("");
  const formRef = useRef<HTMLDivElement>(null);
  const check = () => {
    const e: { bridgeUrl?: string; host?: string } = {};
    if (p.type === "network") {
      if (!p.bridgeUrl || !LOCAL_BRIDGE.test(p.bridgeUrl))
        e.bridgeUrl = t("register.printerBadBridge");
      if (!p.host || !HOST.test(p.host)) e.host = t("register.printerBadHost");
    }
    return e;
  };
  const run = (go: (p: PrinterSettings) => void) => () => {
    const e = check();
    setErrors(e);
    if (Object.keys(e).length === 0) go(p);
    else focusInvalid(formRef.current);
  };
  return (
    <Modal title={t("register.printerTitle")} onClose={onClose}>
      <div ref={formRef} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("register.printerType")}
          <select
            className={selectClass}
            value={p.type}
            onChange={(e) => setP({ ...p, type: e.target.value as PrinterSettings["type"] })}
          >
            <option value="browser">{t("register.printerBrowser")}</option>
            <option value="usb">{t("register.printerUsb")}</option>
            <option value="network">{t("register.printerNetwork")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t("register.printerWidth")}
          <select
            className={selectClass}
            value={p.cols}
            onChange={(e) =>
              setP({
                ...p,
                cols: Number(e.target.value) as PrinterSettings["cols"],
              })
            }
          >
            <option value={32}>{t("register.printerWidth58")}</option>
            <option value={42}>{t("register.printerWidth80")}</option>
            <option value={48}>{t("register.printerWidth80wide")}</option>
          </select>
        </label>
        {p.type === "usb" &&
          (usbSupported() ? (
            <div className="flex flex-col gap-2">
              <Button
                type="button"
                size="touch"
                variant="outline"
                onClick={async () => {
                  setUsbError("");
                  try {
                    setP({ ...p, usb: await chooseUsbPrinter() });
                  } catch (e) {
                    // NotFoundError = the person closed the chooser; anything else is a real problem.
                    if ((e as { name?: string }).name !== "NotFoundError")
                      setUsbError(t("register.printerUsbFailed"));
                  }
                }}
              >
                {t("register.printerUsbPick")}
              </Button>
              {p.usb && <p role="status">{t("register.printerUsbChosen")}</p>}
              {usbError && (
                <p role="alert" className="text-destructive text-sm">
                  {usbError}
                </p>
              )}
            </div>
          ) : (
            <p role="alert" className="text-destructive text-sm">
              {t("register.printerUsbUnsupported")}
            </p>
          ))}
        {p.type === "network" && (
          <>
            <TextField
              id="printer-bridge"
              label={t("register.printerBridge")}
              hint="http://127.0.0.1:9101"
              value={p.bridgeUrl ?? ""}
              error={errors.bridgeUrl}
              onChange={(v) => setP({ ...p, bridgeUrl: v.trim() })}
            />
            <TextField
              id="printer-host"
              label={t("register.printerHost")}
              hint="192.168.1.50:9100"
              value={p.host ?? ""}
              error={errors.host}
              onChange={(v) => setP({ ...p, host: v.trim() })}
            />
          </>
        )}
        <div className="grid grid-cols-3 gap-2">
          <Cancel onClick={onClose} />
          <Button type="button" size="touch" variant="outline" onClick={run(onTest)}>
            {t("register.printerTest")}
          </Button>
          <Button type="button" size="touch" onClick={run(onSave)}>
            {t("register.printerSave")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function EmailDialog({
  onSend,
  onClose,
  status,
  sending,
}: {
  onSend: (to: string) => void;
  onClose: () => void;
  status: string;
  sending: boolean;
}) {
  const [to, setTo] = useState("");
  const [bad, setBad] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <Modal title={t("register.emailTitle")} onClose={onClose}>
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (sending) return;
          if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) onSend(to.trim());
          else {
            setBad(true);
            requestAnimationFrame(() => focusInvalid(formRef.current));
          }
        }}
      >
        <TextField
          id="email-to"
          type="email"
          autoFocus
          label={t("register.emailLabel")}
          required
          value={to}
          error={bad ? t("register.emailBad") : undefined}
          onChange={(v) => {
            setTo(v);
            setBad(false);
          }}
        />
        {(sending || status) && (
          <p role="status" className="text-sm">
            {sending ? t("register.sending") : status}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Cancel onClick={onClose} />
          <Button type="submit" size="touch" aria-disabled={sending}>
            {sending ? t("register.sending") : t("register.emailSend")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

type InvoiceErrors = { name?: string; address?: string; vatNumber?: string };

export function InvoiceDialog({
  shopHasVat,
  initial,
  onDone,
  onClose,
}: {
  shopHasVat: boolean;
  initial?: InvoiceInput;
  onDone: (i: InvoiceInput) => void;
  onClose: () => void;
}) {
  const [v, setV] = useState({
    name: initial?.name ?? "",
    address: initial?.address ?? "",
    vatNumber: initial?.vatNumber ?? "",
  });
  const [errors, setErrors] = useState<InvoiceErrors>({});
  const formRef = useRef<HTMLFormElement>(null);
  if (!shopHasVat)
    return (
      <Modal title={t("register.invoiceTitle")} onClose={onClose}>
        <p role="alert">{t("register.invoiceNeedsVat")}</p>
        <Cancel onClick={onClose} />
      </Modal>
    );
  const set = (key: keyof typeof v) => (value: string) => setV({ ...v, [key]: value });
  return (
    <Modal title={t("register.invoiceTitle")} onClose={onClose}>
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const r = invoiceInput.safeParse(v);
          if (r.success) return onDone(r.data);
          const bad = new Set(r.error.issues.map((i) => i.path[0]));
          setErrors({
            name: bad.has("name") ? t("register.invoiceNameRequired") : undefined,
            address: bad.has("address") ? t("register.invoiceAddressRequired") : undefined,
            vatNumber: bad.has("vatNumber") ? t("register.invoiceVatBad") : undefined,
          });
          requestAnimationFrame(() => focusInvalid(formRef.current));
        }}
      >
        <TextField
          id="invoice-name"
          label={t("register.invoiceName")}
          required
          value={v.name}
          error={errors.name}
          onChange={set("name")}
        />
        <TextField
          id="invoice-address"
          label={t("register.invoiceAddress")}
          required
          value={v.address}
          error={errors.address}
          onChange={set("address")}
        />
        <TextField
          id="invoice-vat"
          label={t("register.invoiceVat")}
          required
          hint="IE6388047V"
          value={v.vatNumber}
          error={errors.vatNumber}
          onChange={set("vatNumber")}
        />
        <div className="grid grid-cols-2 gap-2">
          <Cancel onClick={onClose} />
          <Button type="submit" size="touch">
            {t("register.invoiceMake")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
