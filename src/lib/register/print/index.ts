import type { RegisterDb } from "../db";
import type { Station } from "../ticket";
import { bridgePrint } from "./bridge";
import { encodeEscpos } from "./escpos";
import { usbPrint } from "./usb";

export type PrinterSettings = {
  type: "browser" | "usb" | "network";
  cols: 32 | 42 | 48;
  usb?: { vendorId: number; productId: number };
  bridgeUrl?: string;
  /** host:port of the printer, as the bridge should reach it. */
  host?: string;
};

export const defaultPrinter: PrinterSettings = { type: "browser", cols: 42 };

export async function loadPrinter(db: RegisterDb): Promise<PrinterSettings> {
  return ((await db.meta.get("printer"))?.value as PrinterSettings | undefined) ?? defaultPrinter;
}
export const savePrinter = (db: RegisterDb, value: PrinterSettings) =>
  db.meta.put({ key: "printer", value });

/**
 * Kitchen and bar tickets: which station makes each category (default kitchen) and the printer
 * of each station. A station with no printer prints no ticket. Per device, like the receipt printer.
 */
export type StationSetup = {
  printers: Partial<Record<Station, PrinterSettings>>;
  categories: Record<string, Station>;
};
export const noStations: StationSetup = { printers: {}, categories: {} };

export async function loadStations(db: RegisterDb): Promise<StationSetup> {
  return ((await db.meta.get("stations"))?.value as StationSetup | undefined) ?? noStations;
}
export const saveStations = (db: RegisterDb, value: StationSetup) =>
  db.meta.put({ key: "stations", value });

/**
 * Sends the receipt to the configured printer. "browser" (and any failure, reported by the
 * caller via the returned value) means the caller should open the browser print window.
 * `kick` opens the cash drawer (cash sales only); the browser cannot do that.
 */
export async function printLines(
  p: PrinterSettings,
  lines: readonly string[],
  kick: boolean,
): Promise<"printed" | "browser" | "failed"> {
  try {
    if (p.type === "usb" && p.usb) {
      await usbPrint(p.usb, encodeEscpos(lines, { kick }));
      return "printed";
    }
    if (p.type === "network" && p.bridgeUrl && p.host) {
      await bridgePrint(p.bridgeUrl, p.host, encodeEscpos(lines, { kick }));
      return "printed";
    }
    return p.type === "browser" ? "browser" : "failed";
  } catch {
    return "failed";
  }
}
