// The WebKit pass of `npm run check:responsive`: the owner reads the dashboard in WebKit (Safari, the cmux browser),
// and WebKit lays some things out differently from Chrome (a fit-content <dialog> from a zero flex basis drew as a
// 2px line there only, 072d1d8b). The same pages and rules, in headless WebKit through playwright-core, at the widest
// and the narrowest window, light and dark.
//
// Needs the playwright-core devDependency and its WebKit build (`npm run setup:webkit`, once). Without them the pass
// is skipped with a line saying so; in CI (`CI` set) a missing WebKit fails the check instead.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LIMITS, checkLayout } from "./rules.mjs";

export const WEBKIT_VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
];

/** playwright-core's webkit launcher, or the reason it is not there. */
async function webkitBrowser() {
  let webkit;
  try {
    ({ webkit } = await import("playwright-core"));
  } catch {
    return { missing: "playwright-core is not installed (npm install)" };
  }
  try {
    return { browser: await webkit.launch() };
  } catch (e) {
    return { missing: `WebKit did not start (npm run setup:webkit): ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
}

/**
 * Runs `checkLayout` on every page at WEBKIT_VIEWPORTS in light and dark. `prepare` is the page's PREPARE script (or
 * undefined), `openDetails` opens every <details>. Returns { failures, warnings, checks, skipped }.
 */
export async function webkitPass({ url, pages, prepare, openDetails, shots }) {
  const { browser, missing } = await webkitBrowser();
  if (!browser) {
    if (process.env.CI) return { failures: [`webkit  ${missing}`], warnings: [], checks: 0 };
    return { failures: [], warnings: [], checks: 0, skipped: missing };
  }
  const failures = [];
  const warnings = [];
  let checks = 0;
  await mkdir(shots, { recursive: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    for (const p of pages) {
      for (const theme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: theme });
        for (const vp of WEBKIT_VIEWPORTS) {
          await page.setViewportSize(vp);
          await page.goto(`${url}/app/${p.path}`);
          await page.waitForLoadState("networkidle").catch(() => {});
          if (prepare(p.name)) await page.evaluate(prepare(p.name));
          await page.evaluate(openDetails);
          await page.waitForTimeout(150);
          const { failures: found } = await page.evaluate(`(${checkLayout.toString()})(${JSON.stringify(LIMITS)})`);
          checks++;
          if (found.length === 0) continue;
          const where = `${p.name} ${vp.width}x${vp.height} ${theme} webkit`;
          const shot = join(shots, `${p.name}-${vp.width}x${vp.height}-${theme}-webkit.png`);
          await writeFile(shot, await page.screenshot());
          for (const f of found) (f.warn ? warnings : failures).push(`${where}  ${f.rule}  ${f.selector}  (${f.detail})  ${shot}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  return { failures, warnings, checks };
}
