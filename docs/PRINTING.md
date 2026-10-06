# Printing and cash drawer

The register prints in one of three ways, chosen per device under **Printer** in the register header (stored in that browser only).

| Mode                             | Use when                                                          | Drawer kick                        |
| -------------------------------- | ----------------------------------------------------------------- | ---------------------------------- |
| Browser print                    | Any printer, no setup. Always the fallback if another mode fails. | No                                 |
| USB thermal printer (WebUSB)     | ESC/POS printer plugged into the till (Chrome / Edge, HTTPS).     | Yes, via the printer's drawer port |
| Network printer via print bridge | Ethernet/Wi-Fi ESC/POS printer on port 9100.                      | Yes, via the printer's drawer port |

A cash sale sends a drawer-kick pulse (`ESC p 0 25 250`, pin 2) after the receipt. The drawer must be plugged into the **printer's** RJ11 port. Card-only sales never kick the drawer.

## USB (WebUSB)

1. Use Chrome or Edge. Open Printer, choose **USB**, press **Choose USB printer** and pick the printer.
2. Windows: WebUSB cannot claim a printer that the Windows print driver already owns. Install the **WinUSB** driver for that device once (Zadig, "WinUSB"); it then no longer appears as a normal Windows printer.
3. Press **Test print**. Pick 80 mm = 42 or 48 columns, 58 mm = 32.

## Network printer: the print bridge

A web page cannot open a raw TCP connection, so a tiny local program forwards the bytes.

1. Install Node 20+ on the till computer. Copy `tools/print-bridge/` there.
2. Copy `print-bridge.example.json` to `print-bridge.json`; set `origins` to your Tillflow address and `printers` to the printer's `ip:9100`.
3. Run `node print-bridge.mjs` (use Task Scheduler / NSSM / a systemd unit to start it at boot).
4. In Printer choose **Network**, bridge `http://127.0.0.1:9101`, printer `192.168.1.50:9100`.

The bridge listens on 127.0.0.1 only, accepts requests only from the listed origins, only forwards to listed printers and caps each job at 64 KB. Give the printer a fixed IP.

## Troubleshooting

- "Printer not reached": the browser print window opens instead; the sale is already saved.
- Nothing prints over the bridge: check the bridge console, the `origins`/`printers` lists and that the printer answers on 9100.
- Euro sign shows as `?`: set the printer's code page to 858 (PC858 Euro).
