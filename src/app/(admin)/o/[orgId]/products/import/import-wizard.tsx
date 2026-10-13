"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import {
  fieldLabel,
  IMPORT_TYPES,
  MODES,
  requiredFor,
  type Field,
  type ImportType,
  type Mapping,
} from "@/lib/import/fields";
import { autoMatch, SOURCES, type SourceId } from "@/lib/import/presets";
import {
  DEFAULTS,
  missingFields,
  settingsProblem,
  type ImportSettings,
} from "@/lib/import/settings";

type Uploaded = {
  importType: ImportType;
  importId: string;
  fileName: string;
  headers: string[];
  sample: Record<string, string>[];
  totalRows: number;
  source: SourceId | null;
  mapping: Mapping;
  fields: Field[];
};
type RowError = { row: number; field: string; message: string };
type Preview = {
  totalRows: number;
  readyRows: number;
  errorRows: number;
  willCreate: number;
  willUpdate: number;
  willSkip: number;
  vatDefaulted: number;
  errors: RowError[];
};
type Job = {
  status: "uploaded" | "queued" | "running" | "done" | "failed" | "undone";
  total_rows: number;
  processed_rows: number;
  created_count: number;
  updated_count: number;
  skipped_count: number;
  error_count: number;
  errors: RowError[];
  undo_until: string | null;
};
type Saved = { id: string; name: string; mapping: Mapping };
type Step = "upload" | "map" | "check" | "progress";

const control = "border-input bg-background h-12 w-full rounded-lg border px-3 text-base";
const card = "border-border flex flex-col gap-4 rounded-xl border p-4";

async function call<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; data: T & { error?: string } }> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  return { ok: res.ok, data };
}

export function ImportWizard({
  orgId,
  xlsx,
  initialType,
}: {
  orgId: string;
  xlsx: boolean;
  initialType: ImportType;
}) {
  const [step, setStep] = useState<Step>("upload");
  const [importType, setImportType] = useState<ImportType>(initialType);
  const [up, setUp] = useState<Uploaded | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [source, setSource] = useState<SourceId | "">("");
  const [mode, setMode] = useState<ImportSettings["mode"]>(DEFAULTS[initialType].mode);
  const [matchKey, setMatchKey] = useState<ImportSettings["matchKey"]>(
    DEFAULTS[initialType].matchKey,
  );
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [saved, setSaved] = useState<Saved[]>([]);
  const [saveName, setSaveName] = useState("");
  const [savedPick, setSavedPick] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alertRef = useRef<HTMLParagraphElement>(null);

  const [errorField, setErrorField] = useState<"file" | "map" | "save" | null>(null);
  const firstRender = useRef(true);
  // Move focus to the new step heading, but not when the page first loads.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (error) alertRef.current?.focus();
  }, [error]);

  // Saved matches belong to one kind of import: a product match is never offered for customers.
  const mapType = up?.importType ?? importType;
  const loadSaved = useCallback(async () => {
    const res = await fetch(`/api/v1/imports/mappings?orgId=${orgId}&type=${mapType}`);
    if (res.ok) setSaved((await res.json()) as Saved[]);
  }, [orgId, mapType]);
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const settings = { orgId, mapping, mode, matchKey };
  const post = (path: string, body: unknown) =>
    call<Record<string, never>>(`/api/v1/imports/${up?.importId}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  async function onUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setNotice(null);
    const file = new FormData(e.currentTarget).get("file");
    if (!(file instanceof File) || file.size === 0) {
      setErrorField("file");
      return setError(t("import.err.empty"));
    }
    setBusy(t("import.upload.busy"));
    const body = new FormData();
    body.set("file", file);
    const r = await call<Uploaded>(`/api/v1/imports?orgId=${orgId}&type=${importType}`, {
      method: "POST",
      body,
    });
    setBusy(null);
    if (!r.ok) {
      setErrorField("file");
      return setError(r.data.error ?? t("import.err.generic"));
    }
    setUp(r.data);
    setMapping(r.data.mapping);
    setSource(r.data.source ?? "");
    // Start from this kind of import's usual choices; a stock file with only a barcode column matches by barcode.
    setMode(DEFAULTS[importType].mode);
    setMatchKey(
      importType === "stock" && !r.data.mapping.sku && r.data.mapping.barcode
        ? "barcode"
        : DEFAULTS[importType].matchKey,
    );
    setStep("map");
  }

  async function runPreview(next: { mode?: typeof mode; matchKey?: typeof matchKey } = {}) {
    if (busy) return;
    setError(null);
    setNotice(null);
    setBusy(t("import.map.checking"));
    const r = await post("/preview", { ...settings, ...next });
    setBusy(null);
    if (!r.ok) return setError(r.data.error ?? t("import.err.generic"));
    // A changed choice is kept only once the new figures have arrived.
    if (next.mode) setMode(next.mode);
    if (next.matchKey) setMatchKey(next.matchKey);
    setPreview(r.data as unknown as Preview);
    setStep("check");
  }

  async function onStart() {
    setError(null);
    setNotice(null);
    setBusy(t("import.starting"));
    const r = await post("/confirm", settings);
    if (!r.ok) {
      setBusy(null);
      return setError(r.data.error ?? t("import.err.generic"));
    }
    setBusy(null);
    setJob({
      status: "queued",
      total_rows: preview?.totalRows ?? 0,
      processed_rows: 0,
      created_count: 0,
      updated_count: 0,
      skipped_count: 0,
      error_count: 0,
      errors: [],
      undo_until: null,
    });
    setStep("progress");
  }

  // Poll while the job is queued or running.
  const importId = up?.importId;
  const jobStatus = job?.status;
  useEffect(() => {
    if (
      step !== "progress" ||
      !importId ||
      jobStatus === "done" ||
      jobStatus === "failed" ||
      jobStatus === "undone"
    )
      return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/v1/imports/${importId}?orgId=${orgId}`);
      if (res.ok) setJob((await res.json()) as Job);
    }, 1500);
    return () => clearInterval(timer);
  }, [step, importId, jobStatus, orgId]);

  async function downloadProblems() {
    const res = await fetch(`/api/v1/imports/${up?.importId}/errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    if (!res.ok) return setError(t("import.err.generic"));
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = "import-problems.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onUndo() {
    setError(null);
    setBusy(t("import.progress.undoing"));
    const r = await post("/undo", { orgId });
    setBusy(null);
    if (!r.ok) return setError(r.data.error ?? t("import.err.generic"));
    const d = r.data as unknown as { reverted: number; kept: number };
    setNotice(t("import.progress.undone", { reverted: d.reverted, kept: d.kept }));
    setJob((j) => (j ? { ...j, status: "undone" } : j));
  }

  async function deleteSaved() {
    const hit = saved.find((x) => x.id === savedPick);
    if (!hit || busy) return;
    setError(null);
    const res = await fetch(`/api/v1/imports/mappings?orgId=${orgId}&id=${hit.id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setErrorField("save");
      return setError(t("import.err.generic"));
    }
    setSavedPick("");
    setNotice(t("import.map.deleted", { name: hit.name }));
    void loadSaved();
  }

  async function saveMapping() {
    setError(null);
    setNotice(null);
    const r = await call<{ id: string }>("/api/v1/imports/mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, type: mapType, name: saveName, mapping }),
    });
    if (!r.ok) {
      setErrorField("save");
      return setError(r.data.error ?? t("import.err.generic"));
    }
    setSaveName("");
    setNotice(t("import.map.saved.ok"));
    void loadSaved();
  }

  // After an undo the button that had focus is gone: put focus on the heading.
  useEffect(() => {
    if (jobStatus === "undone") heading.current?.focus();
  }, [jobStatus]);

  const current: ImportSettings = { mapping, mode, matchKey };
  const missing = missingFields(importType, current);
  const problem = settingsProblem(importType, current);
  const modeKey = (m: ImportSettings["mode"]) =>
    importType === "stock"
      ? m === "count"
        ? "import.mode.count"
        : "import.mode.received"
      : importType === "customers"
        ? m === "create"
          ? "import.mode.createCustomers"
          : "import.mode.upsertCustomers"
        : m === "create"
          ? "import.mode.create"
          : "import.mode.upsert";
  const isRequired = (f: Field) =>
    requiredFor(importType).includes(f) || (importType === "stock" && f === matchKey);
  const errorLine = error ? (
    <p
      id="import-error"
      ref={alertRef}
      role="alert"
      tabIndex={-1}
      className="text-destructive text-sm font-medium"
    >
      {error}
    </p>
  ) : null;
  const status = (
    <p role="status" className="text-sm">
      {busy ?? notice ?? ""}
    </p>
  );
  const h2 = (text: string) => (
    <h2 ref={heading} tabIndex={-1} className="text-heading font-semibold outline-none">
      {text}
    </h2>
  );

  if (step === "upload") {
    return (
      <form onSubmit={onUpload} className={card}>
        {h2(t("import.step.upload"))}
        <fieldset className="flex flex-col">
          <legend className="text-sm font-medium">{t("import.type.title")}</legend>
          {IMPORT_TYPES.map((kind) => (
            <label key={kind} className="flex min-h-12 items-start gap-3 py-2 text-base">
              <input
                type="radio"
                name="import-type"
                className="mt-1 size-5"
                checked={importType === kind}
                onChange={() => setImportType(kind)}
              />
              <span className="flex flex-col">
                <span>{t(`import.type.${kind}`)}</span>
                <span className="text-muted-foreground text-xs">
                  {t(`import.type.${kind}Hint`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        {importType === "customers" ? (
          <p className="text-sm font-medium">{t("import.customers.privacy")}</p>
        ) : null}
        <div className="flex flex-col gap-1">
          <label htmlFor="import-file" className="text-sm font-medium">
            {t("import.upload.label")}
          </label>
          <input
            id="import-file"
            name="file"
            type="file"
            accept={xlsx ? ".xlsx,.csv,.json" : ".csv,.json"}
            required
            aria-invalid={errorField === "file" && !!error}
            aria-describedby={
              errorField === "file" && error ? "import-file-hint import-error" : "import-file-hint"
            }
            className={control + " py-2.5"}
          />
          <p id="import-file-hint" className="text-muted-foreground text-sm">
            {t(xlsx ? "import.upload.hint" : "import.upload.hintNoExcel")}
          </p>
        </div>
        <p className="text-muted-foreground text-sm">{t("import.sql")}</p>
        {errorLine}
        {status}
        <div className="flex flex-wrap gap-3">
          <Button
            type="submit"
            size="touch"
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            aria-disabled={busy !== null}
          >
            {t("import.upload.button")}
          </Button>
        </div>
        <div className="border-border flex flex-wrap items-center gap-3 border-t pt-4">
          <span className="text-sm font-medium">{t("import.template.title")}</span>
          <a
            className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
            href={`/api/v1/imports/template?orgId=${orgId}&format=csv&import=${importType}`}
          >
            {t("import.template.csv")}
          </a>
          {xlsx ? (
            <a
              className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
              href={`/api/v1/imports/template?orgId=${orgId}&format=xlsx&import=${importType}`}
            >
              {t("import.template.xlsx")}
            </a>
          ) : null}
        </div>
      </form>
    );
  }

  if (step === "map" && up) {
    return (
      <div className={card}>
        {h2(t("import.step.map"))}
        <p className="text-muted-foreground text-sm">
          {t("import.map.intro")} {importType === "stock" ? t("import.map.introStock") : null}
          {importType === "customers" ? t("import.map.introCustomers") : null}{" "}
          {t("import.map.file", { name: up.fileName, rows: up.totalRows })}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* The Square / Lightspeed / Imonggo / Shopify presets describe product exports only. */}
          <div className={importType === "products" ? "flex flex-col gap-1" : "hidden"}>
            <label htmlFor="import-source" className="text-sm font-medium">
              {t("import.map.preset")}
            </label>
            <select
              id="import-source"
              className={control}
              value={source}
              onChange={(e) => {
                const s = (e.target.value || "") as SourceId | "";
                setSource(s);
                setMapping(autoMatch(up.headers, s || null, up.fields));
              }}
            >
              <option value="">{t("import.map.presetAuto")}</option>
              {(Object.keys(SOURCES) as SourceId[]).map((id) => (
                <option key={id} value={id}>
                  {SOURCES[id].label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="import-saved" className="text-sm font-medium">
              {t("import.map.saved")}
            </label>
            <select
              id="import-saved"
              className={control}
              value={savedPick}
              onChange={(e) => {
                const hit = saved.find((x) => x.id === e.target.value);
                setSavedPick(hit ? hit.id : "");
                if (hit) {
                  // Only the columns this kind of import has (a saved match may come from another kind).
                  setMapping(
                    Object.fromEntries(
                      Object.entries(hit.mapping).filter(([k]) => up.fields.includes(k as Field)),
                    ),
                  );
                  setNotice(t("import.map.applied", { name: hit.name }));
                }
              }}
            >
              <option value="">
                {saved.length ? t("import.map.savedChoose") : t("import.map.savedNone")}
              </option>
              {saved.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            {savedPick ? (
              <Button type="button" variant="outline" size="touch" onClick={deleteSaved}>
                {t("import.map.delete")}
              </Button>
            ) : null}
          </div>
        </div>

        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th scope="col" className="py-2 pr-3">
                {t("import.map.field")}
              </th>
              <th scope="col" className="py-2">
                {t("import.map.column")}
              </th>
            </tr>
          </thead>
          <tbody>
            {up.fields.map((f) => {
              const col = mapping[f] ?? "";
              const example = col ? up.sample[0]?.[col] : "";
              return (
                <tr key={f} className="border-border border-t">
                  <th scope="row" className="py-2 pr-3 font-normal">
                    <label htmlFor={`map-${f}`}>
                      {fieldLabel(importType, f)}
                      {isRequired(f) ? ` (${t("import.map.required")})` : ""}
                    </label>
                  </th>
                  <td className="py-2">
                    <select
                      id={`map-${f}`}
                      className={control}
                      value={col}
                      aria-required={isRequired(f)}
                      aria-invalid={errorField === "map" && !!error && missing.includes(f)}
                      aria-describedby={example ? `map-${f}-ex` : undefined}
                      onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || null })}
                    >
                      <option value="">{t("import.map.none")}</option>
                      {up.headers.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                    {example ? (
                      <span id={`map-${f}-ex`} className="text-muted-foreground block pt-1 text-xs">
                        {t("import.map.example", { value: example })}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-48 flex-col gap-1">
            <label htmlFor="import-save-name" className="text-sm font-medium">
              {t("import.map.saveName")}
            </label>
            <input
              id="import-save-name"
              aria-invalid={errorField === "save" && !!error}
              aria-describedby={errorField === "save" && error ? "import-error" : undefined}
              className={control}
              maxLength={60}
              value={saveName}
              onChange={(e) => setSaveName(e.target.value)}
            />
          </div>
          <Button type="button" variant="outline" size="touch" onClick={saveMapping}>
            {t("import.map.save")}
          </Button>
        </div>
        {errorLine}
        {status}
        <div>
          <Button
            type="button"
            size="touch"
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            aria-disabled={missing.length > 0 || busy !== null}
            onClick={() => {
              if (busy) return;
              if (missing.length) {
                setErrorField("map");
                return setError(t(problem ?? "import.err.required"));
              }
              void runPreview();
            }}
          >
            {t("import.map.next")}
          </Button>
        </div>
      </div>
    );
  }

  if (step === "check" && up && preview) {
    const radio = "flex min-h-12 items-center gap-3 text-base";
    return (
      <div className={card}>
        {h2(t("import.step.check"))}
        {importType === "customers" ? (
          <p className="text-sm font-medium">{t("import.customers.privacy")}</p>
        ) : null}
        <ul aria-live="polite" className="flex flex-col gap-1 text-sm">
          <li>{t("import.check.ready", { count: preview.readyRows })}</li>
          {preview.willCreate && importType !== "stock" ? (
            <li>
              {t(
                importType === "customers" ? "import.check.customersCreate" : "import.check.create",
                {
                  count: preview.willCreate,
                },
              )}
            </li>
          ) : null}
          {preview.willUpdate ? (
            <li>
              {t(
                importType === "stock"
                  ? "import.check.stock"
                  : importType === "customers"
                    ? "import.check.customersUpdate"
                    : "import.check.update",
                { count: preview.willUpdate },
              )}
            </li>
          ) : null}
          {preview.willSkip ? (
            <li>
              {t(importType === "customers" ? "import.check.customersSkip" : "import.check.skip", {
                count: preview.willSkip,
              })}
            </li>
          ) : null}
          {preview.errorRows ? (
            <li className="font-medium">
              {t("import.check.problems", { count: preview.errorRows })}
            </li>
          ) : null}
          {preview.vatDefaulted ? (
            <li>{t("import.check.vat", { count: preview.vatDefaulted })}</li>
          ) : null}
        </ul>

        <fieldset className="flex flex-col">
          <legend className="text-sm font-medium">
            {t(
              importType === "stock"
                ? "import.mode.titleStock"
                : importType === "customers"
                  ? "import.mode.titleCustomers"
                  : "import.mode.title",
            )}
          </legend>
          {MODES[importType].map((m) => (
            <label key={m} className={radio}>
              <input
                type="radio"
                name="mode"
                className="size-5"
                checked={mode === m}
                onChange={() => void runPreview({ mode: m })}
              />
              {t(modeKey(m))}
            </label>
          ))}
        </fieldset>
        {importType !== "customers" ? (
          <fieldset className="flex flex-col">
            <legend className="text-sm font-medium">{t("import.match.title")}</legend>
            {(["sku", "barcode"] as const).map((k) => (
              <label key={k} className={radio}>
                <input
                  type="radio"
                  name="match"
                  className="size-5"
                  checked={matchKey === k}
                  onChange={() => void runPreview({ matchKey: k })}
                />
                {t(k === "sku" ? "import.match.sku" : "import.match.barcode")}
              </label>
            ))}
          </fieldset>
        ) : null}

        {preview.errors.length ? (
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">{t("import.check.errorsTitle")}</h3>
            <div
              className="focus-visible:ring-ring max-h-72 overflow-auto rounded-md outline-none focus-visible:ring-2"
              tabIndex={0}
              role="region"
              aria-label={t("import.check.errorsTitle")}
            >
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="py-1 pr-3">
                      {t("import.check.col.row")}
                    </th>
                    <th scope="col" className="py-1 pr-3">
                      {t("import.check.col.field")}
                    </th>
                    <th scope="col" className="py-1">
                      {t("import.check.col.problem")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {preview.errors.map((e, i) => (
                    <tr key={i} className="border-border border-t">
                      <th scope="row" className="py-1 pr-3 font-normal tabular-nums">
                        {e.row}
                      </th>
                      <td className="py-1 pr-3">{e.field}</td>
                      <td className="py-1">{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.errorRows > 100 ? (
              <p className="text-muted-foreground text-xs">
                {t("import.check.errorsMore", { count: preview.errorRows })}
              </p>
            ) : null}
            <div>
              <Button type="button" variant="outline" size="touch" onClick={downloadProblems}>
                {t("import.check.download")}
              </Button>
            </div>
          </div>
        ) : null}

        {preview.readyRows === 0 ? (
          <p id="import-start-hint" className="text-sm font-medium">
            {t("import.check.none")}
          </p>
        ) : null}
        {errorLine}
        {status}
        <div className="flex flex-wrap gap-3">
          <Button
            type="button"
            size="touch"
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
            aria-describedby={preview.readyRows === 0 ? "import-start-hint" : undefined}
            aria-disabled={busy !== null || preview.readyRows === 0}
            onClick={() => {
              if (preview.readyRows > 0 && !busy) void onStart();
            }}
          >
            {t("import.start")}
          </Button>
          <Button type="button" variant="outline" size="touch" onClick={() => setStep("map")}>
            {t("import.change")}
          </Button>
        </div>
      </div>
    );
  }

  // progress
  const done = job?.status === "done";
  const failed = job?.status === "failed";
  const undone = job?.status === "undone";
  const canUndo = done && job?.undo_until && new Date(job.undo_until) > new Date();
  return (
    <div className={card}>
      {h2(t("import.step.progress"))}
      {failed ? (
        <p role="alert" className="text-destructive text-sm font-medium">
          {t("import.progress.failed")}
        </p>
      ) : (
        <p role="status" className="text-sm">
          {notice ??
            (done || undone
              ? t("import.progress.done", {
                  created: job?.created_count ?? 0,
                  updated: job?.updated_count ?? 0,
                  skipped: job?.skipped_count ?? 0,
                  errors: job?.error_count ?? 0,
                })
              : job?.status === "running"
                ? t("import.progress.working")
                : t("import.progress.queued"))}
        </p>
      )}
      {job?.status === "running" ? (
        // Changes every poll: shown, but not announced.
        <p aria-hidden="true" className="text-muted-foreground text-sm tabular-nums">
          {t("import.progress.running", { done: job.processed_rows, total: job.total_rows })}
        </p>
      ) : null}
      {!done && !failed && !undone ? (
        <progress
          className="h-3 w-full"
          max={job?.total_rows || 1}
          value={job?.processed_rows ?? 0}
          aria-label={t("import.progress.title")}
        />
      ) : null}
      {done && job?.errors.length ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">
            {t("import.progress.problems", { count: Math.min(job.errors.length, 20) })}
          </h3>
          <ul className="text-sm">
            {job.errors.slice(0, 20).map((e, i) => (
              <li key={i}>
                {t("import.check.col.row")} {e.row}: {e.message}
              </li>
            ))}
          </ul>
          <div>
            <Button type="button" variant="outline" size="touch" onClick={downloadProblems}>
              {t("import.check.download")}
            </Button>
          </div>
        </div>
      ) : null}
      {canUndo ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">
            {t("import.progress.undoUntil", {
              time: new Date(job!.undo_until!).toLocaleString("en-IE"),
            })}
          </p>
          <div>
            <Button
              type="button"
              variant="outline"
              size="touch"
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
              aria-disabled={busy !== null}
              onClick={() => {
                if (!busy) void onUndo();
              }}
            >
              {t("import.progress.undo")}
            </Button>
          </div>
        </div>
      ) : null}
      {errorLine}
      <div>
        <a
          href={`/o/${orgId}/products`}
          className="inline-flex min-h-12 items-center text-sm underline underline-offset-4"
        >
          {t("import.back")}
        </a>
      </div>
    </div>
  );
}
