/** The bridge runs on the till computer itself: receipts never go to another host. */
export const LOCAL_BRIDGE = /^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/?$/;

/** Sends ESC/POS bytes to a network printer through the local print bridge (docs/PRINTING.md). */
export async function bridgePrint(
  bridgeUrl: string,
  printer: string,
  data: Uint8Array,
): Promise<void> {
  if (!LOCAL_BRIDGE.test(bridgeUrl)) throw new Error("bridge must be on this computer");
  const res = await fetch(`${bridgeUrl.replace(/\/$/, "")}/print`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", "X-Printer": printer },
    body: data as BufferSource,
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`print bridge ${res.status}`);
}
