/**
 * Why an uploaded file was refused. Each code has a friendly sentence under `import.err.<code>` in
 * src/lib/i18n/import-en-IE.ts. Kept in its own module so the xlsx sandbox and the parser can both
 * use it without importing each other.
 */
export type ImportErrorCode =
  | "sql"
  | "type"
  | "size"
  | "rows"
  | "columns"
  | "empty"
  | "unreadable"
  /** The Excel (.xlsx) importer is switched off (the default until the host has been checked). */
  | "xlsx_disabled"
  /** It is switched on but this host cannot run the isolated parser, so it fails closed. */
  | "xlsx_unavailable"
  /** The isolated parser hit its time, memory or output limit, or crashed. */
  | "complex"
  /** Too many Excel files are being read at once. */
  | "parser_busy";

/** A refusal with a code the UI turns into a friendly message. */
export class ImportFileError extends Error {
  constructor(readonly code: ImportErrorCode) {
    super(code);
  }
}
