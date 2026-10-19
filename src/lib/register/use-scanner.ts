"use client";

import { useEffect, useRef } from "react";

const MAX_GAP_MS = 80; // scanners type far faster than people
const MIN_LENGTH = 3;

/**
 * Keyboard-wedge barcode scanners "type" the code and press Enter. This listens on the whole
 * window, so a scan works wherever the focus is. Keys arriving less than 80 ms apart build up
 * one code; Enter after at least 3 of them is a scan. `enabled` pauses it (dialogs have inputs).
 */
export function useScanner(onScan: (code: string) => void, enabled: boolean) {
  const cb = useRef(onScan);
  const on = useRef(enabled);
  useEffect(() => {
    cb.current = onScan;
    on.current = enabled;
  });
  useEffect(() => {
    let buffer = "";
    let last = 0;
    const onKey = (e: KeyboardEvent) => {
      if (!on.current || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.timeStamp - last > MAX_GAP_MS) buffer = "";
      last = e.timeStamp;
      if (e.key === "Enter") {
        const code = buffer;
        buffer = "";
        if (code.length >= MIN_LENGTH) {
          e.preventDefault();
          cb.current(code);
        }
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
