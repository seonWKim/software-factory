// The system WebKit pass of `npm run check:responsive`, macOS only: the given pages in the Mac's own WebKit (Safari's
// and the cmux browser's engine) through an offscreen WKWebView (system-webkit.swift), at WEBKIT_VIEWPORTS plus 740px,
// light and dark. The playwright WebKit build (webkit.mjs) is newer than the system's: the calendar event popover's body
// drew 24px tall in Safari and the cmux browser but not there (owner #92), so the pages whose dialogs and popovers grew
// from a zero flex basis are checked here too.
//
// Needs `swiftc` (the Xcode command line tools). Elsewhere, or without it, the pass is skipped with a line saying so.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { LIMITS, checkLayout } from "./rules.mjs";
import { WEBKIT_VIEWPORTS } from "./webkit.mjs";

const run = promisify(execFile);
const SOURCE = new URL("./system-webkit.swift", import.meta.url);
export const SYSTEM_WEBKIT_VIEWPORTS = [...WEBKIT_VIEWPORTS, { width: 740, height: 800 }];

/** The compiled runner, cached in the temp dir by the source's hash; or why there is none. */
async function runner() {
  if (process.platform !== "darwin") return { missing: "not macOS" };
  const source = await readFile(SOURCE);
  // In a folder of its own: WebKit keeps its caches in a temp folder named after the executable.
  const dir = join(tmpdir(), `sf-system-webkit-bin-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`);
  const bin = join(dir, "sf-system-webkit");
  if (existsSync(bin)) return { bin };
  try {
    await mkdir(dir, { recursive: true });
    await run("swiftc", ["-O", SOURCE.pathname, "-o", bin], { timeout: 180_000 });
    return { bin };
  } catch (e) {
    return { missing: `swiftc could not build the WebKit runner: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}` };
  }
}

/** Runs `checkLayout` on each page after its `prepare` script. Returns { failures, warnings, checks, skipped }. */
export async function systemWebkitPass({ url, pages, prepare }) {
  if (pages.length === 0) return { failures: [], warnings: [], checks: 0 };
  const { bin, missing } = await runner();
  if (!bin) return { failures: [], warnings: [], checks: 0, skipped: missing };
  const check = `(${checkLayout.toString()})(${JSON.stringify(LIMITS)})`;
  const jobs = [];
  for (const p of pages) {
    for (const dark of [false, true]) {
      for (const vp of SYSTEM_WEBKIT_VIEWPORTS) {
        const where = `${p.name} ${vp.width}x${vp.height} ${dark ? "dark" : "light"} system-webkit`;
        const js = `${prepare(p.name) ? `await ${prepare(p.name)};` : ""} const r = ${check}; return JSON.stringify(r.failures);`;
        jobs.push({ where, job: { url: `${url}/app/${p.path}`, width: vp.width, height: vp.height, dark, js } });
      }
    }
  }
  const file = join(tmpdir(), `sf-system-webkit-jobs-${process.pid}.json`);
  await writeFile(file, JSON.stringify(jobs.map((j) => j.job)));
  let lines;
  try {
    lines = (await run(bin, [file], { timeout: 30_000 * jobs.length, maxBuffer: 16 * 1024 * 1024 })).stdout.trim().split("\n");
  } catch (e) {
    return { failures: [`system-webkit  the WebKit runner failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`], warnings: [], checks: 0 };
  } finally {
    await rm(file, { force: true });
  }
  const failures = [];
  const warnings = [];
  jobs.forEach(({ where }, i) => {
    const found = JSON.parse(lines[i] ?? `{"error":"no result"}`);
    if (!Array.isArray(found)) return failures.push(`${where}  run  (${found?.error ?? "no result"})`);
    for (const f of found) (f.warn ? warnings : failures).push(`${where}  ${f.rule}  ${f.selector}  (${f.detail})`);
  });
  return { failures, warnings, checks: jobs.length };
}
