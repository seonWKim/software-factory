// The quick-add box (docs/design/09-desktop-app.md): the shortcut over a fake globalShortcut, the box with a fake
// window, Enter posting through the main process to the real POST /api/v1/tasks route (in-memory store, no socket),
// Esc posting nothing, and the shortcut settings view. Nothing here starts Electron or calls a remote service.
import { mkdtempSync, readFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "../../src/core/quick-add.js";
import type { UserId } from "../../src/core/types.js";
import { FakeClock } from "../../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../../src/ui/health.js";
import { type ApiDeps, respond } from "../../src/ui/server.js";
import { newCsrfToken } from "../../src/ui/settings-api.js";
import { appDataPaths, loadShellConfig, saveQuickAddShortcut } from "../../desktop/electron/common/app-data.js";
import { quickAddShortcut } from "../../desktop/electron/macos/shortcut.js";
import { type PostFetch, fieldChips, taskPoster, tasksUrl } from "../../desktop/electron/macos/tasks-client.js";
import { createMacosShell } from "../../desktop/electron/macos/app-shell.js";
import { BOX, boxOptions, createQuickAdd } from "../../desktop/electron/macos/quick-add.js";
import { SETTINGS, createSettingsView } from "../../desktop/electron/macos/settings-view.js";
import { newStore } from "../helpers/store.js";
import { electronMock } from "./fakes.js";

const PORT = 4310;
const ACTOR = "local:owner@example.com" as UserId;

/** The macOS shell over mocked Electron, with the quick-add shortcut registered as runShell does. */
function shortcutHarness(opts: { taken?: string[]; accelerator?: string } = {}) {
  const m = electronMock();
  for (const a of opts.taken ?? []) m.globalShortcut.taken.add(a);
  const shell = createMacosShell(m.electron, { preload: "/app/preload.cjs" });
  const messages: string[] = [];
  const saved: string[] = [];
  let presses = 0;
  const shortcut = quickAddShortcut({
    shell,
    accelerator: opts.accelerator ?? "Alt+Space",
    onPress: () => void presses++,
    notify: (msg) => messages.push(msg),
    save: (a) => saved.push(a),
  });
  return { m, shell, shortcut, messages, saved, presses: () => presses };
}

describe("quick-add shortcut on the macOS shell", () => {
  it("registers the default; a press runs the box's opener", () => {
    const h = shortcutHarness();
    expect(h.shortcut.current()).toBe("Alt+Space");
    expect([...h.m.globalShortcut.registered.keys()]).toEqual(["Alt+Space"]);
    h.m.globalShortcut.press("Alt+Space");
    expect(h.presses()).toBe(1);
    expect(h.messages).toEqual([]);
  });

  it("a change registers the new shortcut, releases the old one and saves it", () => {
    const h = shortcutHarness();
    expect(h.shortcut.change("Command+Shift+K")).toEqual({ ok: true, accelerator: "Command+Shift+K" });
    expect([...h.m.globalShortcut.registered.keys()]).toEqual(["Command+Shift+K"]);
    expect(h.shortcut.current()).toBe("Command+Shift+K");
    expect(h.saved).toEqual(["Command+Shift+K"]);
    h.m.globalShortcut.press("Command+Shift+K");
    expect(h.presses()).toBe(1);
  });

  it("a refused accelerator (taken, or not one) keeps the previous shortcut and answers a message", () => {
    const h = shortcutHarness({ taken: ["Command+Space"] });
    for (const bad of ["Command+Space", "not a shortcut!"]) {
      const r = h.shortcut.change(bad);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.message).toContain(`${bad} could not be registered`);
      expect(!r.ok && r.message).toContain("Alt+Space stays");
    }
    expect(h.shortcut.current()).toBe("Alt+Space");
    expect([...h.m.globalShortcut.registered.keys()]).toEqual(["Alt+Space"]);
    expect(h.saved).toEqual([]);
  });

  it("a refused shortcut at start shows a message and holds none; the shell runs on", () => {
    const h = shortcutHarness({ taken: ["Alt+Space"] });
    expect(h.shortcut.current()).toBeNull();
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toContain("Alt+Space could not be registered");
    h.shell.openWindow("http://127.0.0.1:4310/app/");
    expect(h.m.windows).toHaveLength(1);
  });

  it("Quit releases every shortcut", () => {
    const h = shortcutHarness();
    h.m.app.emit("will-quit");
    expect(h.m.globalShortcut.registered.size).toBe(0);
  });
});

/** A fetch onto the real UI request handler over an in-memory store, as the main process's fetch would reach it. */
async function factoryApi() {
  const clock = new FakeClock(new Date("2026-11-12T09:00:00"));
  const { store } = await newStore(clock);
  const d: ApiDeps = {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: 300_000,
    health: new HealthMonitor(async () => [], clock),
    commands: { actor: ACTOR, source: "environment", token: newCsrfToken() },
  };
  const posts: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetch: PostFetch = async (url, init) => {
    const u = new URL(url);
    if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const r = await respond(d, {
      method: init?.method ?? "GET",
      url: u.pathname,
      host: u.host,
      origin: init?.headers.origin,
      contentType: init?.headers["content-type"],
      csrfToken: init?.headers["x-csrf-token"],
      body: init?.body,
    });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => JSON.parse(r.body) };
  };
  return { store, d, fetch, posts, tasks: () => store.listTasks(100) };
}

async function boxHarness(opts: { post?: Parameters<typeof createQuickAdd>[1]["post"]; parse?: typeof parseQuickAdd | null } = {}) {
  const m = electronMock();
  const api = await factoryApi();
  let n = 0;
  const box = createQuickAdd(m.electron, {
    pageUrl: "file:///app/quick-add.html",
    preload: "/app/panel-preload.cjs",
    post: opts.post ?? taskPoster({ fetch: api.fetch, port: PORT }),
    parse: opts.parse === undefined ? parseQuickAdd : opts.parse,
    newId: () => `tk_box000000${++n}`,
  });
  box.prepare();
  const win = m.windows[0]!;
  const key = (k: string, words: string) => m.ipcMain.invoke(BOX.key, win.webContents, k, words);
  const preview = (words: string) => m.ipcMain.invoke(BOX.preview, win.webContents, words);
  return { m, api, box, win, key, preview };
}

describe("quick-add box", () => {
  it("is made hidden and frameless at start, sandboxed, on its own page only", async () => {
    const h = await boxHarness();
    expect(h.m.windows).toHaveLength(1);
    expect(h.win.options).toEqual(boxOptions("/app/panel-preload.cjs"));
    expect(h.win.options).toMatchObject({ frame: false, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    expect(h.win.visible).toBe(false);
    expect(h.win.loads).toEqual(["file:///app/quick-add.html"]);
    expect(h.win.navigate("https://example.com/")).toBe(false);
    expect(h.win.openHandler!()).toEqual({ action: "deny" });
  });

  it("the shortcut opens the box at once and focuses its text field", async () => {
    const h = await boxHarness();
    const shell = createMacosShell(h.m.electron, { preload: "/app/preload.cjs" });
    quickAddShortcut({ shell, accelerator: "Alt+Space", onPress: () => h.box.open(), notify: () => {}, save: () => {} });
    h.m.globalShortcut.press("Alt+Space");
    // Synchronously: no await between the press and the shown, focused box.
    expect(h.win.visible).toBe(true);
    expect(h.win.focused).toBe(true);
    expect(h.win.sent).toEqual([BOX.opened]);
    expect(h.m.windows).toHaveLength(1);
  });

  it("Enter posts one task to POST /api/v1/tasks with the parsed fields, then closes the box", async () => {
    const h = await boxHarness();
    h.box.open();
    const r = await h.key("Enter", "pay rent tomorrow 09:30 !1 #home every month");
    expect(h.api.posts).toHaveLength(1);
    expect(h.api.posts[0]).toMatchObject({
      url: tasksUrl(PORT),
      body: { id: "tk_box0000001", words: "pay rent tomorrow 09:30 !1 #home every month" },
      headers: { origin: `http://127.0.0.1:${PORT}`, "content-type": "application/json", "x-csrf-token": h.api.d.commands!.token },
    });
    const stored = await h.api.tasks();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: "tk_box0000001", title: "pay rent", list: "home", priority: 1, due_date: "2026-11-13", due_time: "09:30", recurrence: "month", created_by: ACTOR,
    });
    expect(r).toMatchObject({ task: { id: "tk_box0000001", title: "pay rent" } });
    expect(h.win.visible).toBe(false);
  });

  it("Esc closes the box, posts nothing and stores nothing", async () => {
    const h = await boxHarness();
    h.box.open();
    expect(await h.key("Escape", "pay rent tomorrow")).toEqual({ closed: true });
    expect(h.win.visible).toBe(false);
    expect(h.api.posts).toEqual([]);
    expect(await h.api.tasks()).toEqual([]);
  });

  it("clicking elsewhere closes the box and posts nothing", async () => {
    const h = await boxHarness();
    h.box.open();
    h.win.blur();
    expect(h.win.visible).toBe(false);
    expect(h.api.posts).toEqual([]);
  });

  it("a second Enter while the first is on its way posts nothing more", async () => {
    let release!: () => void;
    const calls: string[] = [];
    const h = await boxHarness({
      post: async (b) => {
        calls.push(b.id);
        await new Promise<void>((r) => (release = r));
        return { ok: true, task: { id: b.id } };
      },
    });
    h.box.open();
    const first = h.key("Enter", "call the bank");
    expect(await h.key("Enter", "call the bank")).toEqual({ pending: true });
    release();
    await first;
    expect(calls).toEqual(["tk_box0000001"]);
  });

  it("a refused post shows the reason, keeps the box open and resends under the same task ID", async () => {
    const h = await boxHarness();
    h.box.open();
    expect(await h.key("Enter", "every fortnight call mum")).toEqual({ error: expect.stringContaining("unknown recurrence") });
    expect(h.win.visible).toBe(true);
    await h.key("Enter", "call mum every week today");
    expect(h.api.posts.map((p) => (p.body as { id: string }).id)).toEqual(["tk_box0000001", "tk_box0000001"]);
    expect((await h.api.tasks()).map((t) => t.title)).toEqual(["call mum"]);
  });

  it("an unreachable factory answers a message and stores nothing", async () => {
    const h = await boxHarness({ post: taskPoster({ fetch: async () => Promise.reject(new Error("ECONNREFUSED")), port: PORT }) });
    h.box.open();
    expect(await h.key("Enter", "call the bank")).toEqual({ error: expect.stringContaining("not reachable") });
    expect(await h.api.tasks()).toEqual([]);
  });

  it("shows the parsed fields as chips while typing, and none without the parser", async () => {
    const h = await boxHarness();
    expect(await h.preview("pay rent tomorrow 09:30 !1 #home every month")).toEqual({
      chips: [
        { field: "due", text: "tomorrow" },
        { field: "time", text: "09:30" },
        { field: "priority", text: "!1" },
        { field: "list", text: "#home" },
        { field: "recurrence", text: "every month" },
      ],
      problem: null,
    });
    expect(await h.preview("!5 x")).toMatchObject({ chips: [], problem: expect.stringContaining("priority") });
    const bare = await boxHarness({ parse: null });
    expect(await bare.preview("pay rent tomorrow")).toEqual({ chips: [], problem: null });
  });

  it("answers only its own page", async () => {
    const h = await boxHarness();
    expect(await h.m.ipcMain.invoke(BOX.key, {}, "Enter", "call the bank")).toBeNull();
    expect(h.api.posts).toEqual([]);
  });

  it("fieldChips names a calendar date as typed", () => {
    expect(fieldChips({ title: "t", list: null, priority: null, due: { date: "2026-12-01" }, due_time: null, recurrence: null })).toEqual([{ field: "due", text: "2026-12-01" }]);
  });
});

describe("shortcut settings view", () => {
  function settingsHarness() {
    const m = electronMock();
    m.globalShortcut.taken.add("Command+Space");
    const shell = createMacosShell(m.electron, { preload: "/app/preload.cjs" });
    const paths = appDataPaths(mkdtempSync(join(tmpdir(), "sf-desktop-home-")));
    loadShellConfig(paths, nodeFs, "/src/software-factory");
    const shortcut = quickAddShortcut({ shell, accelerator: "Alt+Space", onPress: () => {}, notify: () => {}, save: (a) => saveQuickAddShortcut(paths, nodeFs, a) });
    const view = createSettingsView(m.electron, { pageUrl: "file:///app/settings.html", preload: "/app/panel-preload.cjs", shortcut });
    view.open();
    const win = m.windows.at(-1)!;
    const ask = (channel: string, ...args: unknown[]) => m.ipcMain.invoke(channel, win.webContents, ...args);
    const config = () => JSON.parse(readFileSync(paths.config, "utf8")) as Record<string, unknown>;
    return { m, view, win, ask, config, shortcut };
  }

  it("opens one focused window showing the current shortcut", async () => {
    const h = settingsHarness();
    expect(h.win.focused).toBe(true);
    expect(h.win.loads).toEqual(["file:///app/settings.html"]);
    h.view.open();
    expect(h.m.windows).toHaveLength(1);
    expect(await h.ask(SETTINGS.get)).toEqual({ shortcut: "Alt+Space" });
  });

  it("saves a free shortcut into config.json, keeping the other keys", async () => {
    const h = settingsHarness();
    expect(await h.ask(SETTINGS.set, "Control+Alt+T")).toEqual({ ok: true, accelerator: "Control+Alt+T" });
    expect(h.config()).toMatchObject({ checkout: "/src/software-factory", ui_port: 4310, app: { quick_add_shortcut: "Control+Alt+T" } });
    expect(h.m.globalShortcut.isRegistered("Alt+Space")).toBe(false);
  });

  it("refuses a taken shortcut with a message and keeps the previous one, in the system and the file", async () => {
    const h = settingsHarness();
    expect(await h.ask(SETTINGS.set, "Command+Space")).toEqual({ ok: false, message: expect.stringContaining("Alt+Space stays") });
    expect(h.shortcut.current()).toBe("Alt+Space");
    expect(h.m.globalShortcut.isRegistered("Alt+Space")).toBe(true);
    expect(h.config()).toMatchObject({ app: { quick_add_shortcut: "Alt+Space" } });
  });

  it("answers only its own page", async () => {
    const h = settingsHarness();
    expect(await h.m.ipcMain.invoke(SETTINGS.set, {}, "Control+Alt+T")).toBeNull();
    expect(h.shortcut.current()).toBe("Alt+Space");
  });
});
