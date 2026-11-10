// A headless Chrome driven over the DevTools protocol with Node's built-in WebSocket: no Playwright, no new
// dependency. Finds the system Chrome (macOS app, or google-chrome / chromium on PATH as on CI's ubuntu runners;
// CHROME_PATH overrides), starts it with a throwaway profile and talks to one page target.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAC_APPS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];
const ON_PATH = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];

/** The Chrome binary to run, or null when none is installed. */
export function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const p of MAC_APPS) if (existsSync(p)) return p;
  for (const name of ON_PATH) {
    const r = spawnSync("which", [name], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A cold Chrome on a fresh CI runner can take well over 10s to open its DevTools port, and now and then one
// never does; a slow start waits, a stuck one is killed and Chrome is started again with a fresh profile.
const PORT_TIMEOUT_MS = process.env.CI ? 30_000 : 15_000;
const LAUNCH_ATTEMPTS = 3;
const STDERR_TAIL_LINES = 20;

/** Starts headless Chrome and returns a Page on a fresh tab, plus close(). Tries up to LAUNCH_ATTEMPTS times. */
export async function launch(binary) {
  const failures = [];
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    try {
      return await launchOnce(binary);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      failures.push(`attempt ${attempt}: ${reason}`);
      if (attempt < LAUNCH_ATTEMPTS) console.warn(`check:responsive: warning: Chrome launch attempt ${attempt} failed, retrying with a fresh profile: ${reason.split("\n")[0]}`);
    }
  }
  throw new Error(`Chrome did not start after ${LAUNCH_ATTEMPTS} attempts (${binary}):\n${failures.join("\n")}`);
}

/** One launch with its own profile; on any failure Chrome's process group and profile are removed before it throws. */
async function launchOnce(binary) {
  const profile = await mkdtemp(join(tmpdir(), "sf-responsive-chrome-"));
  const proc = spawn(
    binary,
    [
      "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
      "--disable-background-networking", "--disable-extensions", "--force-color-profile=srgb",
      // CI runners start Chrome as root in a container-like VM, where the setuid sandbox is unavailable.
      ...(process.getuid?.() === 0 || process.env.CI ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    // Its own process group, so close() can kill the helper processes with it.
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );
  let stderr = "";
  let spawnError = null;
  proc.on("error", (e) => (spawnError = e)); // e.g. ENOENT: without a listener it would crash the check
  proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-16_000)));
  const exited = new Promise((r) => (proc.exitCode !== null || proc.signalCode !== null ? r() : proc.once("close", r)));
  const status = () => spawnError ? `could not start: ${spawnError.message}`
    : proc.exitCode !== null ? `exited with code ${proc.exitCode}`
    : proc.signalCode !== null ? `exited on signal ${proc.signalCode}`
    : "was still running (killed)";
  const why = (headline, status) => {
    const lines = stderr.trimEnd().split("\n").slice(-STDERR_TAIL_LINES);
    const tail = lines.join("") === "" ? "(no stderr output)" : lines.map((l) => `    ${l}`).join("\n");
    return `${headline}; Chrome ${status}; last ${STDERR_TAIL_LINES} lines of its stderr:\n${tail}`;
  };
  try {
    const started = Date.now();
    const port = await devtoolsPort(proc, profile, () => stderr, () => spawnError);
    if (port === null) throw new Error(`Chrome did not open its DevTools port (waited ${((Date.now() - started) / 1000).toFixed(1)}s of ${PORT_TIMEOUT_MS / 1000}s)`);
    const { webSocketDebuggerUrl: browserUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const tab = targets.find((t) => t.type === "page");
    if (!tab) throw new Error(`Chrome opened port ${port} but has no page target`);
    const page = await Page.connect(tab.webSocketDebuggerUrl);
    return {
      page,
      /** Closes Chrome and waits for it to exit before removing its profile; a cleanup failure only warns. */
      async close() {
        page.close();
        // Browser.close lets Chrome stop its helper processes and flush the profile; killing only the main
        // process leaves them writing into Default/ while it is removed (ENOTEMPTY on CI).
        await closeBrowser(browserUrl).catch(() => {});
        await stop(proc, exited, profile, 5_000);
      },
    };
  } catch (e) {
    const state = status(); // before stop() kills it: a hung Chrome and a crashed one need different fixes
    await stop(proc, exited, profile, 0);
    throw new Error(why(e instanceof Error ? e.message : String(e), state));
  }
}

/**
 * The DevTools port, from whichever comes first: the "DevTools listening on ws://127.0.0.1:<port>/..." line on
 * stderr or the DevToolsActivePort file in the profile. Null when Chrome exits or PORT_TIMEOUT_MS passes first.
 */
async function devtoolsPort(proc, profile, stderr, spawnError) {
  const deadline = Date.now() + PORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const m = /DevTools listening on ws:\/\/[^:\s]+:(\d+)\//.exec(stderr());
    if (m) return Number(m[1]);
    try {
      const port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]);
      if (port > 0) return port;
    } catch {
      // not written yet
    }
    if (spawnError() || proc.exitCode !== null || proc.signalCode !== null) return null;
    await sleep(100);
  }
  return null;
}

/** Waits up to `grace_ms` for Chrome to exit, then kills its process group, then removes its profile. */
async function stop(proc, exited, profile, grace_ms) {
  if (proc.pid !== undefined && !(await within(exited, grace_ms))) {
    killGroup(proc, "SIGKILL");
    await within(exited, 5_000);
  }
  try {
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.warn(`check:responsive: warning: could not remove Chrome's profile ${profile}: ${e instanceof Error ? e.message : e}`);
  }
}

/** Sends Browser.close on the browser target and waits for its reply (or the socket closing), at most 5s. */
async function closeBrowser(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`could not connect to ${url}`));
  });
  const done = new Promise((r) => {
    ws.onmessage = r;
    ws.onclose = r;
    ws.onerror = r;
  });
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  await within(done, 5_000);
  ws.close();
}

/** Kills Chrome and its helpers: it runs in its own process group (spawned detached). */
function killGroup(proc, signal) {
  try {
    process.kill(-proc.pid, signal);
  } catch {
    proc.kill(signal);
  }
}

/** True when `promise` settles within `ms`. */
const within = (promise, ms) => Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);

/** One page target: send(method, params), events by name, and the waits the check needs. */
export class Page {
  #ws;
  #seq = 0;
  #pending = new Map();
  #listeners = new Map();
  #inflight = new Map(); // requestId -> loaderId of the document that sent it
  #lastNetwork = Date.now();
  #loader = null;

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`could not connect to ${url}`));
    });
    const page = new Page(ws);
    await Promise.all([page.send("Page.enable"), page.send("Runtime.enable"), page.send("Network.enable")]);
    return page;
  }

  constructor(ws) {
    this.#ws = ws;
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        this.#pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(`${p.method}: ${msg.error.message}`));
        else p?.resolve(msg.result);
        return;
      }
      for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
    };
    // Network idle: no request of the current document in flight for a while (the app polls every few seconds,
    // so never "none ever"). Requests of a document navigated away from may never report loadingFinished or
    // loadingFailed, and counting them would hold every later wait at its cap; a wait that hits it warns.
    this.on("Network.requestWillBeSent", (p) => {
      this.#inflight.set(p.requestId, p.loaderId);
      if (p.loaderId === this.#loader) this.#lastNetwork = Date.now();
    });
    const done = (p) => (this.#inflight.delete(p.requestId), (this.#lastNetwork = Date.now()));
    this.on("Network.loadingFinished", done);
    this.on("Network.loadingFailed", done);
  }

  send(method, params = {}) {
    const id = ++this.#seq;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject, method }));
  }

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
  }

  /** The next `event`'s params. */
  once(event) {
    return new Promise((resolve) => {
      const fn = (p) => {
        const list = this.#listeners.get(event);
        list.splice(list.indexOf(fn), 1);
        resolve(p);
      };
      this.on(event, fn);
    });
  }

  /** Evaluates `expression` in the page and returns its (awaited) value. */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page script failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }

  /** Navigates and waits for the load event, then for the network to stay idle for `idle_ms` (at most `max_ms`). */
  async goto(url, { idle_ms = 400, max_ms = 3_000 } = {}) {
    const loaded = this.once("Page.loadEventFired");
    this.#inflight.clear();
    const { loaderId, errorText } = await this.send("Page.navigate", { url });
    if (errorText) throw new Error(`navigating to ${url}: ${errorText}`);
    this.#loader = loaderId;
    await loaded;
    await this.idle({ idle_ms, max_ms });
  }

  async idle({ idle_ms = 400, max_ms = 3_000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < max_ms) {
      if (this.#busy() === 0 && Date.now() - this.#lastNetwork >= idle_ms) return;
      await sleep(50);
    }
    console.warn(`check:responsive: warning: the network did not go idle within ${max_ms}ms (${this.#busy()} request(s) in flight)`);
  }

  /** Requests of the current document still in flight. */
  #busy() {
    let n = 0;
    for (const loader of this.#inflight.values()) if (loader === this.#loader) n++;
    return n;
  }

  close() {
    this.#ws.close();
  }
}
