/** Screenshots of /design and both layouts into docs/screenshots. Run with the dev server up:
 *  E2E_BASE_URL=http://localhost:3100 pnpm exec tsx scripts/design-screenshots.ts [light|dark] */
import { chromium } from "@playwright/test";

const base = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const scheme = (process.argv[2] ?? "light") as "light" | "dark";
const pages = [
  ["design", "/design", true],
  ["back-office", "/design/back-office", false],
  ["register", "/design/register", false],
  ["register-offline", "/design/register?state=offline", false],
] as const;
const sizes = [
  ["1024x768", { width: 1024, height: 768 }],
  ["390x844", { width: 390, height: 844 }],
] as const;

async function main() {
  const browser = await chromium.launch();
  for (const [sizeName, viewport] of sizes) {
    const ctx = await browser.newContext({ viewport, colorScheme: scheme });
    const page = await ctx.newPage();
    for (const [name, path, full] of pages) {
      await page.goto(base + path, { waitUntil: "networkidle" });
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }); // dev-only badge
      await page.screenshot({
        path: `docs/screenshots/${name}-${sizeName}-${scheme}.png`,
        fullPage: full,
      });
    }
    await ctx.close();
  }
  await browser.close();
}
main();
