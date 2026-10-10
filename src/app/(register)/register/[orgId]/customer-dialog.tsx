"use client";

import { useRef, useState } from "react";
import { v7 as uuidv7 } from "uuid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/lib/i18n";
import { Cancel, Modal } from "./dialogs";

/** What the till keeps in memory about the customer on this sale. Never written to IndexedDB. */
export type TillCustomer = { id: string; name: string };

/** A search hit: the name plus a masked hint (j***@example.com, ends 567) to tell namesakes apart. */
type Found = TillCustomer & { hint?: string | null };

type FormKey = "name" | "email" | "phone" | "vatNumber";
const FIELD_ORDER: FormKey[] = ["name", "email", "phone", "vatNumber"];
const FIELD_ERROR: Record<FormKey, Parameters<typeof t>[0]> = {
  name: "till.customer.errName",
  email: "till.customer.errEmail",
  phone: "till.customer.errPhone",
  vatNumber: "till.customer.errVat",
};

/**
 * Pick or add the customer for this sale. Online only: customers are looked up on the server (they
 * are personal data, so the device does not hold a copy), and the sale carries just the id.
 */
export function CustomerDialog({
  orgId,
  onPick,
  onClose,
}: {
  orgId: string;
  onPick: (c: TillCustomer) => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"find" | "new">("find");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Found[] | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", vatNumber: "" });
  const [consent, setConsent] = useState(false);
  const [bad, setBad] = useState<FormKey[]>([]);
  const [emailTaken, setEmailTaken] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);

  const offline = typeof navigator !== "undefined" && !navigator.onLine;

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (q.trim().length < 2) return setStatus(t("till.customer.short"));
    setBusy(true);
    setStatus("");
    try {
      const r = await fetch(
        `/api/v1/register/customers?orgId=${encodeURIComponent(orgId)}&q=${encodeURIComponent(q.trim())}`,
        { cache: "no-store" },
      );
      if (!r.ok) throw new Error("search");
      const body = (await r.json()) as { customers: Found[] };
      setResults(body.customers);
      // The count is announced by the status region; focus stays where the cashier is.
      setStatus(
        body.customers.length === 0
          ? t("till.customer.none")
          : t("till.customer.found", { count: body.customers.length }),
      );
    } catch {
      setStatus(t("till.customer.failed"));
      statusRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  /** Mark the fields, say which in the status line, and move focus to the first one. */
  function showBad(fields: FormKey[], taken = false) {
    setBad(fields);
    setEmailTaken(taken);
    setBusy(false);
    // The field error (linked to the focused input) carries the detail; the status line the summary.
    setStatus(taken ? "" : t("till.customer.invalid"));
    document.getElementById(`cust-${fields[0]}`)?.focus();
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    // The server checks everything again; this only saves a round trip for the obvious mistakes.
    const early: FormKey[] = [];
    if (form.name.trim() === "") early.push("name");
    if (form.email.trim() !== "" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim()))
      early.push("email");
    if (early.length > 0) return showBad(early);
    setBad([]);
    setBusy(true);
    setStatus("");
    try {
      const r = await fetch(`/api/v1/register/customers?orgId=${encodeURIComponent(orgId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: uuidv7(), ...form, consent }),
      });
      if (r.status === 409) {
        showBad(["email"], true);
      } else if (r.status === 400) {
        const body = (await r.json().catch(() => ({}))) as { fields?: string[] };
        const fields = FIELD_ORDER.filter((k) => body.fields?.includes(k));
        showBad(fields.length > 0 ? fields : ["name"]);
      } else if (!r.ok) {
        setStatus(t("till.customer.failed"));
      } else {
        const body = (await r.json()) as { customer: Found };
        return onPick(body.customer);
      }
    } catch {
      setStatus(t("till.customer.failed"));
    }
    setBusy(false);
    statusRef.current?.focus();
  }

  if (offline) {
    return (
      <Modal title={t("till.customer.title")} onClose={onClose}>
        <p role="alert">{t("till.customer.offline")}</p>
        <Cancel onClick={onClose} />
      </Modal>
    );
  }

  const field = (key: FormKey, label: string, type = "text", required = false) => (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={`cust-${key}`} className="text-sm font-medium">
        {label}
        {required ? ` ${t("till.customer.required")}` : ""}
      </label>
      <Input
        id={`cust-${key}`}
        aria-required={required || undefined}
        aria-invalid={bad.includes(key) ? true : undefined}
        aria-describedby={bad.includes(key) ? `cust-${key}-err` : undefined}
        type={type}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        autoComplete="off"
        className="h-12"
      />
      {bad.includes(key) ? (
        <p id={`cust-${key}-err`} className="text-destructive text-sm">
          {key === "email" && emailTaken ? t("till.customer.emailTaken") : t(FIELD_ERROR[key])}
        </p>
      ) : null}
    </div>
  );

  return (
    <Modal title={t("till.customer.title")} onClose={onClose}>
      <p ref={statusRef} role="status" tabIndex={-1} className="text-sm outline-none empty:hidden">
        {status}
      </p>
      {mode === "find" ? (
        <div className="flex flex-col gap-3">
          <form onSubmit={search} role="search" className="flex items-end gap-2">
            <div className="flex flex-1 flex-col gap-1.5">
              <label htmlFor="cust-q" className="text-sm font-medium">
                {t("till.customer.search")}
              </label>
              <Input
                id="cust-q"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                maxLength={60}
                autoComplete="off"
                autoFocus
                className="h-12"
              />
            </div>
            <Button type="submit" size="touch" aria-disabled={busy || undefined}>
              {busy ? t("till.customer.searching") : t("till.customer.searchButton")}
            </Button>
          </form>
          {results && results.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {results.map((c) => (
                <li key={c.id}>
                  <Button
                    type="button"
                    size="touch"
                    variant="outline"
                    className="h-auto min-h-12 w-full flex-col items-start py-2"
                    onClick={() => onPick({ id: c.id, name: c.name })}
                  >
                    <span className="font-medium">{c.name}</span>
                    {c.hint ? (
                      <span className="text-muted-foreground text-sm">{c.hint}</span>
                    ) : null}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="touch" variant="outline" onClick={() => setMode("new")}>
              {t("till.customer.new")}
            </Button>
            <Cancel onClick={onClose} />
          </div>
        </div>
      ) : (
        <form onSubmit={create} className="flex flex-col gap-3">
          {field("name", t("customers.field.name"), "text", true)}
          {field("email", t("customers.field.email"), "email")}
          {field("phone", t("customers.field.phone"), "tel")}
          {field("vatNumber", t("customers.field.vat"))}
          <label className="flex min-h-12 items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
              className="size-6"
            />
            {t("till.customer.consent")}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="touch" aria-disabled={busy || undefined}>
              {busy ? t("till.customer.adding") : t("till.customer.create")}
            </Button>
            <Button type="button" size="touch" variant="outline" onClick={() => setMode("find")}>
              {t("till.customer.back")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
