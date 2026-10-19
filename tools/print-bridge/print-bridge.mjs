// Tillflow print bridge: lets the register (a web page) reach a network ESC/POS printer.
// Node 20+, no dependencies. Run: node print-bridge.mjs  (config: print-bridge.json, see docs/PRINTING.md)
import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";

const cfg = JSON.parse(readFileSync(new URL("./print-bridge.json", import.meta.url), "utf8"));
const PORT = cfg.port ?? 9101;
const origins = new Set(cfg.origins ?? []);
const printers = new Set(cfg.printers ?? []); // "host:port" allowlist: this is not an open relay
const MAX = 64 * 1024;

const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin && origins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Printer");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method !== "POST" || req.url !== "/print" || !origin || !origins.has(origin))
    return res.writeHead(403).end();
  const target = String(req.headers["x-printer"] ?? "");
  if (!printers.has(target)) return res.writeHead(403).end("printer not allowed");
  const [host, port] = target.split(":");
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX) req.destroy();
    else chunks.push(c);
  });
  req.on("end", () => {
    const fail = () => {
      if (!res.headersSent) res.writeHead(502).end();
    };
    const sock = net.connect({ host, port: Number(port), timeout: 4000 }, () =>
      sock.end(Buffer.concat(chunks), () => {
        if (!res.headersSent) res.writeHead(204).end();
      }),
    );
    sock.on("error", fail);
    sock.on("timeout", () => {
      sock.destroy();
      fail();
    });
  });
});
// Loopback only: other machines on the LAN cannot use it.
server.listen(PORT, "127.0.0.1", () => console.log(`print bridge on http://127.0.0.1:${PORT}`));
