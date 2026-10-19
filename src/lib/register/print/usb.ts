// WebUSB transport. Minimal types: only what is used here (no @types dependency).
type UsbEndpoint = { endpointNumber: number; direction: "in" | "out"; type: string };
type UsbDevice = {
  vendorId: number;
  productId: number;
  opened: boolean;
  configuration: {
    interfaces: { interfaceNumber: number; alternate: { endpoints: UsbEndpoint[] } }[];
  } | null;
  open(): Promise<void>;
  selectConfiguration(n: number): Promise<void>;
  claimInterface(n: number): Promise<void>;
  transferOut(endpoint: number, data: BufferSource): Promise<unknown>;
};
type Usb = {
  getDevices(): Promise<UsbDevice[]>;
  requestDevice(o: { filters: object[] }): Promise<UsbDevice>;
};

const usb = (): Usb | undefined =>
  typeof navigator === "undefined" ? undefined : (navigator as unknown as { usb?: Usb }).usb;

export const usbSupported = () => !!usb();

/** Must be called from a click: the browser shows its device chooser. Returns vendor/product ids. */
export async function chooseUsbPrinter(): Promise<{ vendorId: number; productId: number }> {
  const d = await usb()!.requestDevice({ filters: [{ classCode: 7 }, {}] }); // printer class first
  return { vendorId: d.vendorId, productId: d.productId };
}

export async function usbPrint(
  id: { vendorId: number; productId: number },
  data: Uint8Array,
): Promise<void> {
  const dev = (await usb()?.getDevices())?.find(
    (d) => d.vendorId === id.vendorId && d.productId === id.productId,
  );
  if (!dev) throw new Error("usb printer not available");
  if (!dev.opened) await dev.open();
  if (!dev.configuration) await dev.selectConfiguration(1);
  for (const itf of dev.configuration!.interfaces) {
    const out = itf.alternate.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
    if (!out) continue;
    await dev.claimInterface(itf.interfaceNumber);
    await dev.transferOut(out.endpointNumber, data as BufferSource);
    return;
  }
  throw new Error("usb printer has no bulk endpoint");
}
