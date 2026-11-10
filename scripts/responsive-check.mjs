// `npm run check:responsive`: the dashboard must not break when the window's width or height changes. A local
// development check (not a factory feature), run in CI on every PR and push to main and by .claude/agents/ui-reviewer.md.
//
// It seeds a throwaway store (scripts/responsive/fixture.mjs), serves it with the built UI server on a free port,
// opens every dashboard page in the system's headless Chrome over CDP (scripts/responsive/cdp.mjs) at each
// VIEWPORT in light and dark, and applies the rules in scripts/responsive/rules.mjs. One line per failure; a
// screenshot of each failing page/viewport/theme, failing elements outlined, under .playwright-mcp/responsive/.
//
// Usage: npm run check:responsive [-- --page settings]   (needs `npm run build` first; the npm script builds)
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./responsive/cdp.mjs";
import { startFixture } from "./responsive/fixture.mjs";
import { LIMITS, checkLayout } from "./responsive/rules.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = join(ROOT, ".playwright-mcp", "responsive");

export const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  // Short: sticky headers and panels must not cover the content or make it unreachable.
  { width: 390, height: 560 },
];
const THEMES = ["light", "dark"];

/** The sidebar's pages, read from web/src/pages.ts so a new page is checked without editing this script. */
async function sidebarPages() {
  const src = await readFile(join(ROOT, "web", "src", "pages.ts"), "utf8");
  return [...src.matchAll(/\{\s*path:\s*"([^"]*)",\s*label:\s*"([^"]+)"/g)].map((m) => ({ name: m[1] || "floor", path: m[1] }));
}

// Clicks that show more of a page without writing anything: Data's work_items table, then every <details>.
const PREPARE = {
  data: `[...document.querySelectorAll('nav[aria-label="Tables"] button')].find((b) => b.textContent.startsWith("work_items"))?.click()`,
};
const OPEN_DETAILS = `document.querySelectorAll("details").forEach((d) => (d.open = true))`;

async function main() {
  const only = process.argv.includes("--page") ? process.argv[process.argv.indexOf("--page") + 1] : null;
  const chrome = findChrome();
  if (!chrome) {
    console.error("check:responsive: no Chrome or Chromium found (set CHROME_PATH)");
    return 2;
  }
  const started = Date.now();
  const fixture = await startFixture();
  const browser = await launch(chrome);
  const { page } = browser;
  const enc = encodeURIComponent;
  const pages = [
    ...(await sidebarPages()),
    { name: "item", path: `items/${enc(fixture.pages.item)}` },
    { name: "item-phases", path: `items/${enc(fixture.pages.parent)}` },
    { name: "transcript", path: `items/${enc(fixture.pages.item)}/runs/${enc(fixture.pages.run)}` },
  ].filter((p) => only === null || p.name === only);

  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
  const failures = [];
  let checks = 0;
  try {
    for (const p of pages) {
      for (const theme of THEMES) {
        await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        await page.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORTS[0], deviceScaleFactor: 1, mobile: false });
        await page.goto(`${fixture.url}/app/${p.path}`);
        // The app keeps a chosen theme in localStorage (sf-theme); the profile is fresh, so it follows the media.
        if (PREPARE[p.name]) {
          await page.eval(PREPARE[p.name]);
          await page.idle();
        }
        await page.eval(OPEN_DETAILS);
        const dark = await page.eval(`document.documentElement.classList.contains("dark")`);
        if (dark !== (theme === "dark")) throw new Error(`${p.name}: the page did not follow prefers-color-scheme: ${theme}`);
        for (const vp of VIEWPORTS) {
          await page.send("Emulation.setDeviceMetricsOverride", { ...vp, deviceScaleFactor: 1, mobile: false });
          await page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
          await page.eval(`document.querySelectorAll("[data-responsive-fail]").forEach((e) => e.removeAttribute("data-responsive-fail"))`);
          const found = await page.eval(`(${checkLayout.toString()})(${JSON.stringify(LIMITS)})`);
          checks++;
          if (found.length === 0) continue;
          const where = `${p.name || "floor"} ${vp.width}x${vp.height} ${theme}`;
          const shot = join(SHOTS, `${p.name}-${vp.width}x${vp.height}-${theme}.png`);
          // Failing elements outlined in red, the first one scrolled into view.
          await page.eval(`(() => {
            const s = document.createElement("style");
            s.id = "responsive-outline";
            s.textContent = "[data-responsive-fail]{outline:2px solid red !important;outline-offset:-1px}";
            document.head.append(s);
            document.querySelector("body [data-responsive-fail]")?.scrollIntoView({ block: "center" });
          })()`);
          const { data } = await page.send("Page.captureScreenshot", { format: "png" });
          await page.eval(`document.getElementById("responsive-outline")?.remove(); scrollTo(0, 0)`);
          await writeFile(shot, Buffer.from(data, "base64"));
          for (const f of found) failures.push(`${where}  ${f.rule}  ${f.selector}  (${f.detail})  ${shot.slice(ROOT.length)}`);
        }
      }
    }
  } finally {
    await browser.close();
    await fixture.close();
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  for (const line of failures) console.log(line);
  const summary = `${pages.length} pages x ${VIEWPORTS.length} viewports x ${THEMES.length} themes = ${checks} checks in ${secs}s`;
  if (failures.length === 0) {
    console.log(`check:responsive: ok (${summary})`);
    return 0;
  }
  console.log(`check:responsive: ${failures.length} failure(s) (${summary}); screenshots in .playwright-mcp/responsive/`);
  return 1;
}

// Exits at once: a WebSocket to the killed Chrome can otherwise hold the process open for its close timeout.
process.exit(
  await main().catch((e) => {
    console.error(`check:responsive: ${e instanceof Error ? e.stack : String(e)}`);
    return 2;
  }),
);
