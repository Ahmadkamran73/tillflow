/** WCAG contrast of the token pairs in globals.css. Run: pnpm exec tsx scripts/check-contrast.ts */
import { readFileSync } from "node:fs";

const css = readFileSync("src/app/globals.css", "utf8").split(String.fromCharCode(13)).join("");
const block = (sel: string) => css.match(new RegExp(String.raw`\n${sel} {([^]*?)\n}`))![1]!;

function vars(body: string) {
  const m = new Map<string, string>();
  for (const [, k, v] of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) m.set(k!, v!.trim());
  return m;
}
function hexLum(h: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}
function lum(v: string, all: Map<string, string>, depth = 0): [number, number] {
  const ref = v.match(/^var\(--([\w-]+)\)$/);
  if (ref && depth < 5) return lum(all.get(ref[1]!)!, all, depth + 1);
  if (v.startsWith("#")) return [hexLum(v), 0];
  const m = v.match(/oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+%?))?\)/)!;
  const [L, C, h] = [+m[1]!, +m[2]!, (+m[3]! * Math.PI) / 180];
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s;
  const y =
    0.2126 * Math.min(1, Math.max(0, r)) +
    0.7152 * Math.min(1, Math.max(0, g)) +
    0.0722 * Math.min(1, Math.max(0, bl));
  return [y, 0];
}
const pairs: [string, string, number][] = [
  ["foreground", "background", 4.5],
  ["foreground", "card", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "card", 4.5],
  ["muted-foreground", "muted", 4.5],
  ["muted-foreground", "secondary", 4.5],
  ["muted-foreground", "paper", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["accent-foreground", "accent", 4.5],
  ["destructive", "background", 4.5],
  ["destructive", "card", 4.5],
  ["success-foreground", "success", 4.5],
  ["info-foreground", "info", 4.5],
  ["warning-foreground", "warning", 4.5],
  ["ember-foreground", "ember", 4.5],
  ["sidebar-foreground", "sidebar", 4.5],
  ["sidebar-foreground", "sidebar-accent", 4.5],
  ["sidebar-primary-foreground", "sidebar-primary", 4.5],
  ["ember", "sidebar", 3],
  ["input", "background", 3],
  ["input", "card", 3],
  ["ring", "background", 3],
  ["ring", "card", 3],
  ["solid-border", "solid", 3],
  ["foreground", "paper", 4.5],
  ["foreground", "accent", 4.5],
  ["muted-foreground", "accent", 4.5],
  ["input", "paper", 3],
  ["solid-border", "paper", 3],
  ["primary", "paper", 3],
];
let fail = 0;
for (const [name, body] of [
  ["light", block(":root")],
  ["dark", block(String.raw`\.dark`)],
]) {
  const all = new Map([...vars(block(":root")), ...vars(body as string)]);
  for (const [fg, bg, min] of pairs) {
    const [a] = lum(all.get(fg)!, all);
    const [b] = lum(all.get(bg)!, all);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < min) {
      fail++;
      console.log(`${name}: ${fg} on ${bg} = ${ratio.toFixed(2)} (< ${min})`);
    }
  }
}
console.log(fail ? `${fail} failing pairs` : "all pairs pass");
process.exit(fail ? 1 : 0);
