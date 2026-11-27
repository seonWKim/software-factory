// `npm run check:responsive`: the dashboard must not break when the window's width or height changes. A local
// development check (not a factory feature), run in CI on every PR and push to main and by .claude/agents/ui-reviewer.md.
//
// It seeds a throwaway store (scripts/responsive/fixture.mjs), serves it with the built UI server on a free port,
// opens every dashboard page in the system's headless Chrome over CDP (scripts/responsive/cdp.mjs) at each
// VIEWPORT in light and dark, and applies the rules in scripts/responsive/rules.mjs: the layout rules and the page
// template's structure rules, whose h1 and h2 sizes are also compared across pages (`heading-size`, against the first
// page with that heading at the same viewport and theme). One line per failure; a
// screenshot of each failing page/viewport/theme, failing elements outlined, under .playwright-mcp/responsive/.
// A console error or a failed request (scripts/responsive/console.mjs) at a page/viewport/theme fails it too.
// Then the same pages and rules in headless WebKit at 1280 and 390 wide, light and dark (scripts/responsive/webkit.mjs),
// the engine the owner reads the dashboard in; skipped with a note when WebKit is not installed (npm run setup:webkit).
// Last, on macOS, the "popover-" pages in the Mac's own WebKit (scripts/responsive/system-webkit.mjs), which drew the
// calendar popover's body 24px tall where the playwright WebKit build did not.
//
// Usage: npm run check:responsive [-- --page settings]   (needs `npm run build` first; the npm script builds)
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, launch } from "./responsive/cdp.mjs";
import { startFixture } from "./responsive/fixture.mjs";
import { LIMITS, checkLayout } from "./responsive/rules.mjs";
import { SYSTEM_WEBKIT_VIEWPORTS, systemWebkitPass } from "./responsive/system-webkit.mjs";
import { WEBKIT_VIEWPORTS, webkitPass } from "./responsive/webkit.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SHOTS = join(ROOT, ".playwright-mcp", "responsive");

export const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  // Below the sidebar's 1024px breakpoint, with the icon-only sidebar: row titles must not wrap (title-wrap).
  { width: 800, height: 1024 },
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

/**
 * Opens a Calendar popover: Month first when `month`, then presses the first painted element matching `target` (an
 * event chip, or a month cell's "+N more") and waits for its dialog, so overlay-bounds and panel-collapsed check it.
 */
const openCalendar = (month, target) => `(async () => {
  // Up to 3 seconds by the clock (a hidden WebKit view slows its timers to one a second).
  const wait = async (find) => { for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) { const el = find(); if (el) return el; } return null; };
  if (${month}) [...document.querySelectorAll("[role=radio]")].find((b) => b.textContent.trim() === "Month" && b.getAttribute("aria-checked") !== "true")?.click();
  const el = await wait(() => [...document.querySelectorAll(${JSON.stringify(target)})].find((b) => b.getClientRects().length > 0 && (!${month} || b.closest("[role=table], [data-selected-day]"))));
  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.click();
  await wait(() => document.querySelector("dialog[open]"));
  // A timer, not requestAnimationFrame: an offscreen WebKit view (system-webkit.swift) draws no frames.
  await new Promise((r) => setTimeout(r, 150));
})()`;

// Clicks that show more of a page without writing anything: Data's work_items table, then every <details>.
// The two "menu-" entries open a ⋯ menu (the top bar's More, the first Schedules row's), so overlay-bounds and small-target
// check the open menu at every viewport. The "popover-" entries open the Calendar's event popover in Week and Month
// and a month day's "+N more" list (owner #92: the popover's body drew 24px tall in WebKit). "dialog-new-event" opens the
// Calendar's New event dialog, so its fields are checked at every viewport (1280 and 390 among them).
const PREPARE = {
  data: `[...document.querySelectorAll('nav[aria-label="Tables"] button')].find((b) => b.textContent.startsWith("work_items"))?.click()`,
  "menu-top": `document.querySelector('header [aria-haspopup="menu"]')?.click()`,
  "menu-row": `document.querySelector('main [aria-haspopup="menu"]')?.click()`,
  "popover-week": openCalendar(false, '[data-capture-open="calendar-event"]'),
  "popover-month": openCalendar(true, '[data-capture-open="calendar-event"]'),
  "popover-more": openCalendar(true, "[data-more]"),
  "dialog-new-event": `(async () => {
    const wait = async (find) => { for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) { const el = find(); if (el) return el; } return null; };
    (await wait(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "New event")))?.click();
    await wait(() => document.querySelector("dialog[open]"));
    await new Promise((r) => setTimeout(r, 150));
  })()`,
};

/**
 * Opens the Evals page of `skill` in place, as the dashboard's own links do: the server answers 404 to a full load of
 * /app/evals/<skill>, since a skill ref is a folder path and an /app path segment may not decode to hold "/". So the
 * entry loads `data` (the page the sidebar marks for an evals page) and moves to evals/<skill> with pushState and a
 * popstate. It waits for the SKILL.md diff (the versions and the diff loaded, so the Compare Card is drawn too).
 */
const openEvals = (skill) => `(async () => {
  const wait = async (find) => { for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) { const el = find(); if (el) return el; } return null; };
  history.pushState(null, "", ${JSON.stringify(`/app/evals/${encodeURIComponent(skill)}`)});
  dispatchEvent(new PopStateEvent("popstate"));
  await wait(() => document.querySelector("[data-skill-diff]"));
  await new Promise((r) => setTimeout(r, 150));
})()`;
/**
 * The Chat page with a conversation: one answer, then a send that fails with one long unbroken token in its error (a
 * request id), as a model error reads. The chat's send route is answered in the page (no model in the fixture), so the
 * error row and Try again are checked at every viewport (owner 2026-11-27: at 767px the column ran past the right edge).
 */
const CHAT_ERROR = `(async () => {
  const wait = async (find) => { for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) { const el = find(); if (el) return el; } return null; };
  const real = window.fetch;
  let n = 0;
  const answer = (body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  window.fetch = (url, init) => !String(url).includes("/api/v1/chat/send") ? real(url, init) : Promise.resolve(++n === 1
    ? answer({ turn_id: "ct_1", session_id: "cs_1", outcome: "answered", reply: "Two tasks need you: the calendar sync review and the failed typecheck." }, 200)
    : answer({ error: "model_error: overloaded_error request_id=req_011CVXyZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ" }, 500));
  const field = await wait(() => document.querySelector("textarea"));
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  const say = async (text) => {
    set.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    (await wait(() => { const b = document.querySelector("form button[type=submit]"); return b && !b.disabled ? b : null; }))?.click();
  };
  await say("What needs me right now, and which of the failed runs from last night should I look at first?");
  await wait(() => document.querySelector('[data-from="chat"] p'));
  await say("And the second one?");
  await wait(() => document.querySelector("[role=alert]"));
  await new Promise((r) => setTimeout(r, 150));
})()`;
const OPEN_DETAILS =`document.querySelectorAll("details").forEach((d) => (d.open = true))`;

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
    // Health's Runs tab: the worker process rows (checked by title-wrap), Failures and the Host sleeps rows.
    { name: "health-runs", path: "health?tab=runs" },
    // Health's Cost and Review tabs: Spend, Efficiency, the unreviewed merges and the improve report.
    { name: "health-cost", path: "health?tab=cost" },
    { name: "health-review", path: "health?tab=review" },
    // Health's Activity tab: the actors, the selected actor's About card and its recent actions.
    { name: "health-activity", path: "health?tab=activity" },
    { name: "transcript", path: `items/${enc(fixture.pages.item)}/runs/${enc(fixture.pages.run)}` },
    { name: "menu-top", path: "schedules" },
    { name: "menu-row", path: "schedules" },
    { name: "popover-week", path: "calendar" },
    { name: "popover-month", path: "calendar" },
    { name: "popover-more", path: "calendar" },
    // The Evals page of the fixture skill (two versions, the newer one current) with its Compare and SKILL.md diff
    // Cards, reached from Data in place (openEvals: a full load of evals/<skill> is a 404).
    { name: "evals", path: "data" },
    { name: "dialog-new-event", path: "calendar" },
    { name: "chat-error", path: "chat" },
  ].filter((p) => only === null || p.name === only);
  const prepare = { ...PREPARE, evals: openEvals(fixture.pages.skill), "chat-error": CHAT_ERROR };

  await rm(SHOTS, { recursive: true, force: true });
  await mkdir(SHOTS, { recursive: true });
  const failures = [];
  /** Findings of the rules in LIMITS.warnOnly: printed, never failing the check. */
  const warnings = [];
  /** The first page's h1 and h2 font sizes per viewport and theme: every other page must match them. */
  const headingSizes = new Map();
  let checks = 0;
  try {
    for (const p of pages) {
      for (const theme of THEMES) {
        await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
        await page.send("Emulation.setDeviceMetricsOverride", { ...VIEWPORTS[0], deviceScaleFactor: 1, mobile: false });
        await page.goto(`${fixture.url}/app/${p.path}`);
        // The app keeps a chosen theme in localStorage (sf-theme); the profile is fresh, so it follows the media.
        if (prepare[p.name]) {
          await page.eval(prepare[p.name]);
          await page.idle();
        }
        await page.eval(OPEN_DETAILS);
        const dark = await page.eval(`document.documentElement.classList.contains("dark")`);
        if (dark !== (theme === "dark")) throw new Error(`${p.name}: the page did not follow prefers-color-scheme: ${theme}`);
        for (const vp of VIEWPORTS) {
          await page.send("Emulation.setDeviceMetricsOverride", { ...vp, deviceScaleFactor: 1, mobile: false });
          await page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
          // An open menu or popover measures its side when it opens: close and open it again at this size.
          if (p.name.startsWith("menu-") || p.name.startsWith("popover-")) {
            await page.eval(`document.querySelector('[aria-haspopup="menu"][aria-expanded="true"], [aria-haspopup="dialog"][aria-expanded="true"]')?.click()`);
            await page.eval(prepare[p.name]);
            await page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
          }
          await page.eval(`document.querySelectorAll("[data-responsive-fail]").forEach((e) => e.removeAttribute("data-responsive-fail"))`);
          const { failures: found, sizes } = await page.eval(`(${checkLayout.toString()})(${JSON.stringify(LIMITS)})`);
          checks++;
          const where = `${p.name || "floor"} ${vp.width}x${vp.height} ${theme}`;
          for (const [tag, size] of Object.entries(sizes)) {
            if (size === null) continue;
            const key = `${tag} ${vp.width}x${vp.height} ${theme}`;
            const first = headingSizes.get(key);
            if (!first) headingSizes.set(key, { size, page: p.name });
            else if (first.size !== size) failures.push(`${where}  heading-size  ${tag}  (${size}, the ${first.page} page's ${tag} is ${first.size})`);
          }
          // What the page logged since its load (at the first viewport) or the previous viewport.
          for (const message of page.takeConsole()) failures.push(`${where}  console  ${message}`);
          if (found.length === 0) continue;
          const shot = join(SHOTS, `${p.name}-${vp.width}x${vp.height}-${theme}.png`);
          // Failing elements outlined in red, the first one scrolled into view. Set through the CSSOM: the page's CSP
          // (style-src 'self') blocks an injected <style>, and the blocked style showed up as a console failure.
          const OUTLINE = `document.querySelectorAll("[data-responsive-fail]").forEach((e) => { e.style.setProperty("outline", "2px solid red", "important"); e.style.setProperty("outline-offset", "-1px"); })`;
          await page.eval(`${OUTLINE}; document.querySelector("body [data-responsive-fail]")?.scrollIntoView({ block: "center" })`);
          const { data } = await page.send("Page.captureScreenshot", { format: "png" });
          await page.eval(`document.querySelectorAll("[data-responsive-fail]").forEach((e) => { e.style.removeProperty("outline"); e.style.removeProperty("outline-offset"); }); scrollTo(0, 0)`);
          await writeFile(shot, Buffer.from(data, "base64"));
          for (const f of found) (f.warn ? warnings : failures).push(`${where}  ${f.rule}  ${f.selector}  (${f.detail})  ${shot.slice(ROOT.length)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  const chromeSecs = ((Date.now() - started) / 1000).toFixed(1);
  const webkitStarted = Date.now();
  let webkit;
  let system;
  let webkitSecs;
  try {
    webkit = await webkitPass({ url: fixture.url, pages, prepare: (name) => prepare[name], openDetails: OPEN_DETAILS, shots: SHOTS });
    webkitSecs = ((Date.now() - webkitStarted) / 1000).toFixed(1);
    system = await systemWebkitPass({ url: fixture.url, pages: pages.filter((p) => p.name.startsWith("popover-")), prepare: (name) => prepare[name] });
  } finally {
    await fixture.close();
  }
  failures.push(...webkit.failures, ...system.failures);
  warnings.push(...webkit.warnings, ...system.warnings);
  if (webkit.skipped) console.log(`check:responsive: WebKit pass skipped: ${webkit.skipped}`);
  if (system.skipped) console.log(`check:responsive: system WebKit pass skipped: ${system.skipped}`);

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  for (const line of warnings) console.log(`warn  ${line}`);
  if (warnings.length > 0) console.log(`check:responsive: ${warnings.length} warning(s) from ${LIMITS.warnOnly.join(", ")} (not failing)`);
  for (const line of failures) console.log(line);
  const summary = `${pages.length} pages x ${VIEWPORTS.length} viewports x ${THEMES.length} themes = ${checks} checks in ${chromeSecs}s, WebKit ${WEBKIT_VIEWPORTS.length} viewports x ${THEMES.length} themes = ${webkit.checks} checks in ${webkitSecs}s, system WebKit ${SYSTEM_WEBKIT_VIEWPORTS.length} viewports = ${system.checks} checks, ${secs}s in all`;
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
