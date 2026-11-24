// The screenshot run's capture (docs/design/04-screenshots.md), run by the worker's Chrome browser
// (src/shared/chrome-browser.ts) through the run's sandbox, in the checkout it built. It seeds the same throwaway fixture store as
// `npm run check:responsive` (fixture.mjs: no real item, token or secret), serves it with the checkout's built UI
// server and opens headless Chrome through the check's driver (cdp.mjs). Nothing is written to disk but the fixture's
// and Chrome's temp folders, both removed on exit: every image goes back to the worker on stdout.
//
// Protocol, one JSON object per line. In, on stdin: the shots, {"shoot": {path, width, height, theme, open?}}, where a path's
// ":item" and ":run" stand for the fixture's item and run IDs, and `open` is the value of the `data-capture-open` attribute of
// the button to click once the page is drawn, to open a dialog (the shot fails, naming it, when no dialog opens). Out first: {"ready": true} or {"error", "unavailable": true};
// then one line per shot, in order: {"png": <base64>} or {"error"}. stdin closing ends the script.
//
// Each shot is the whole page (decision 2026-11-24): the page is laid out at the shot's fixed height, then the window
// grows to the content's full height and the capture takes all of it. The dashboard's shell is one window high and its
// content column scrolls (`[data-scroll-root]`), so the document alone is never taller than the window.
import { createInterface } from "node:readline";
import { findChrome, launch } from "./cdp.mjs";

// stdout carries the protocol only: anything the fixture or the driver logs goes to stderr.
console.log = console.error;
console.warn = console.error;
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const message = (e) => (e instanceof Error ? e.message : String(e)).split("\n")[0];
/** The content's full height in CSS pixels: the document's, or the window less the scroll column's box plus all it scrolls. */
const FULL_HEIGHT = `(() => {
  const root = document.querySelector("[data-scroll-root]");
  const column = root ? window.innerHeight - root.clientHeight + root.scrollHeight : 0;
  return Math.ceil(Math.max(document.documentElement.scrollHeight, column));
})()`;
/** Whether a dialog is open: the dashboard's modals are native <dialog> elements mounted open. */
const DIALOG_OPEN = `Boolean(document.querySelector("dialog[open]"))`;
const frames = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;

/**
 * Clicks the button marked `data-capture-open="<name>"` (waiting for the page to draw it) and waits for a dialog to be
 * drawn and its reads to settle; throws a reason when there is no button or no dialog within five seconds.
 */
async function openDialog(page, name) {
  const click = `(() => { const b = document.querySelector(${JSON.stringify(`[data-capture-open="${name}"]:not([disabled])`)}); if (b) b.click(); return Boolean(b); })()`;
  let clicked = false;
  for (let i = 0; i < 50; i++) {
    clicked ||= await page.eval(click);
    if (clicked && (await page.eval(DIALOG_OPEN))) {
      await page.idle();
      return page.eval(frames);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the ${name} dialog did not open${clicked ? "" : ": no enabled button is marked for it"}`);
}

async function main() {
  const chrome = findChrome();
  if (!chrome) return out({ error: "Chrome is not installed on this worker (set CHROME_PATH)", unavailable: true });
  let fixture;
  try {
    fixture = await (await import("./fixture.mjs")).startFixture();
  } catch (e) {
    return out({ error: `the fixture dashboard did not start: ${message(e)}`, unavailable: true });
  }
  let browser;
  try {
    browser = await launch(chrome);
  } catch (e) {
    await fixture.close();
    return out({ error: `Chrome did not start: ${message(e)}`, unavailable: true });
  }
  try {
    const at = (path) => path.replace(":item", encodeURIComponent(fixture.pages.item)).replace(":run", encodeURIComponent(fixture.pages.run));
    out({ ready: true });
    const { page } = browser;
    for await (const line of createInterface({ input: process.stdin })) {
      const { shoot } = JSON.parse(line);
      try {
        await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: shoot.theme }] });
        const metrics = (height) => page.send("Emulation.setDeviceMetricsOverride", { width: shoot.width, height, deviceScaleFactor: 1, mobile: false });
        await metrics(shoot.height);
        await page.goto(`${fixture.url}/app/${at(shoot.path)}`);
        await page.eval(frames);
        if (shoot.open) await openDialog(page, shoot.open);
        const full = Math.max(shoot.height, await page.eval(FULL_HEIGHT));
        if (full > shoot.height) {
          await metrics(full);
          await page.eval(frames);
        }
        const clip = { x: 0, y: 0, width: shoot.width, height: full, scale: 1 };
        const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip });
        out({ png: data });
      } catch (e) {
        out({ error: message(e) });
      }
    }
  } finally {
    await browser.close();
    await fixture.close();
  }
}

await main().catch((e) => out({ error: message(e) }));
// A WebSocket to the closed Chrome can otherwise hold the process open for its close timeout.
process.exit(0);
