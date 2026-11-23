// The screenshot run's capture (docs/design/04-screenshots.md), run by the worker's Chrome browser
// (src/shared/chrome-browser.ts) through the run's sandbox, in the checkout it built. It seeds the same throwaway fixture store as
// `npm run check:responsive` (fixture.mjs: no real item, token or secret), serves it with the checkout's built UI
// server and opens headless Chrome through the check's driver (cdp.mjs). Nothing is written to disk but the fixture's
// and Chrome's temp folders, both removed on exit: every image goes back to the worker on stdout.
//
// Protocol, one JSON object per line. In, on stdin: the shots, {"shoot": {path, width, height, theme}}, where a path's
// ":item" and ":run" stand for the fixture's item and run IDs. Out first: {"ready": true} or {"error", "unavailable": true};
// then one line per shot, in order: {"png": <base64>} or {"error"}. stdin closing ends the script.
import { createInterface } from "node:readline";
import { findChrome, launch } from "./cdp.mjs";

// stdout carries the protocol only: anything the fixture or the driver logs goes to stderr.
console.log = console.error;
console.warn = console.error;
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const message = (e) => (e instanceof Error ? e.message : String(e)).split("\n")[0];

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
        await page.send("Emulation.setDeviceMetricsOverride", { width: shoot.width, height: shoot.height, deviceScaleFactor: 1, mobile: false });
        await page.goto(`${fixture.url}/app/${at(shoot.path)}`);
        await page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
        const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
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
