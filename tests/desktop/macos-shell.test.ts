// The macOS shell with Electron mocked: the window's options and its one URL, close vs Quit, the menu bar.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRODUCT_NAME } from "../../desktop/electron/common/product.js";
import { STARTUP_ERROR_TITLE, createMacosShell, windowOptions } from "../../desktop/electron/macos/app-shell.js";
import { electronMock, flush } from "./fakes.js";

const DASHBOARD = "http://127.0.0.1:4310/app/";
const DESKTOP = join(import.meta.dirname, "..", "..", "desktop", "electron");

function opened(keepRunningWhenClosed?: boolean) {
  const m = electronMock();
  const shell = createMacosShell(m.electron, { preload: "/app/preload.cjs", ...(keepRunningWhenClosed === undefined ? {} : { keepRunningWhenClosed }) });
  let drains = 0;
  shell.onQuit(async () => void drains++);
  shell.openWindow(DASHBOARD);
  return { m, shell, win: m.windows[0]!, drains: () => drains };
}

describe("macOS shell window", () => {
  it("has contextIsolation on, nodeIntegration off, sandbox on, and loads only the dashboard", () => {
    const { win } = opened();
    expect(win.options).toEqual(windowOptions("/app/preload.cjs"));
    expect(win.options).toMatchObject({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    expect(win.loads).toEqual([DASHBOARD]);
    expect(win.navigate(`${DASHBOARD}items/1`)).toBe(true);
    expect(win.navigate("https://example.com/")).toBe(false);
    expect(win.navigate("http://127.0.0.1:4310/api/v1/overview")).toBe(false);
    expect(win.openHandler!()).toEqual({ action: "deny" });
  });

  it("closing the window keeps the menu bar item and the factory running by default", async () => {
    const { m, win, drains } = opened();
    win.close();
    await flush();
    expect(win.destroyed).toBe(false);
    expect(win.visible).toBe(false);
    expect(m.tray.made).toBe(1);
    expect(drains()).toBe(0);
    expect(m.exited()).toBe(false);
  });

  it("Cmd+Q drains the factory, then exits", async () => {
    const { m, drains } = opened();
    m.app.quit();
    await flush();
    expect(drains()).toBe(1);
    expect(m.state.exitCode).toBe(0);
  });

  it("the menu bar Quit drains the factory, then exits; its Open dashboard shows the window", async () => {
    const { m, win, drains } = opened();
    win.close();
    m.menuItem("Open dashboard").click!();
    expect(win.visible).toBe(true);
    const quit = m.menuItem("Quit Gongbang");
    expect(quit.accelerator).toBe("Command+Q");
    quit.click!();
    await flush();
    expect(drains()).toBe(1);
    expect(m.exited()).toBe(true);
  });

  it("with keep-running off, closing the window is a Quit", async () => {
    const { m, drains } = opened(false);
    m.windows[0]!.close();
    await flush();
    expect(drains()).toBe(1);
    expect(m.exited()).toBe(true);
  });

  it("the menu shows the factory state and the needs-you count", () => {
    const { m, shell } = opened();
    shell.setStatus({ state: "running", needsYou: 4 });
    expect(m.tray.title).toBe("Gb 4");
    expect(m.tray.menu.map((i) => i.label)).toContain("Factory: running");
    expect(m.tray.menu.map((i) => i.label)).toContain("Needs you: 4");
  });
});

describe("the product name", () => {
  it("is desktop/package.json's productName, Gongbang", () => {
    const pkg = JSON.parse(readFileSync(join(DESKTOP, "..", "package.json"), "utf8"));
    expect(pkg.productName).toBe("Gongbang");
    expect(PRODUCT_NAME).toBe("Gongbang");
  });

  it("names the window, the tray tooltip and the Quit item", () => {
    const { m, win, shell } = opened();
    expect(win.options.title).toBe("Gongbang");
    shell.setStatus({ state: "running", needsYou: 1 });
    expect(m.tray.tooltip).toBe("Gongbang: running");
    expect(m.menuItem("Quit Gongbang")).toBeDefined();
    expect(m.tray.menu.map((i) => i.label).filter((l) => /Software Factory/.test(l ?? ""))).toEqual([]);
  });

  it("names the startup error dialog, which main.js shows", () => {
    expect(STARTUP_ERROR_TITLE).toBe("Gongbang could not start");
    const main = readFileSync(join(DESKTOP, "macos", "main.js"), "utf8");
    expect(main).toMatch(/dialog\.showErrorBox\(STARTUP_ERROR_TITLE,/);
    expect(main).not.toContain("Software Factory");
  });
});

describe("desktop/electron sources", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(join(dir, e.name)) : /\.c?js$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  it("only macos/main.js and the panels' sandboxed preload import electron", () => {
    const importers = sources(DESKTOP)
      .filter((f) => /from\s+["']electron["']|require\(\s*["']electron["']\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(DESKTOP.length + 1))
      .sort();
    expect(importers).toEqual(["macos/main.js", "macos/panel-preload.cjs"]);
  });

  it("the panels' preload gives the page only the panel channels", () => {
    const preload = readFileSync(join(DESKTOP, "macos", "panel-preload.cjs"), "utf8");
    expect(preload).toContain('exposeInMainWorld("sf"');
    expect([...preload.matchAll(/"((?:quick-add|settings):[a-z]+)"/g)].map((x) => x[1]).sort()).toEqual(
      ["quick-add:key", "quick-add:opened", "quick-add:preview", "settings:get", "settings:set"],
    );
    expect(preload).not.toMatch(/ipcRenderer\.send|require\(\s*["'](?!electron)/);
  });

  it("the panels' pages name no colour values of their own", () => {
    for (const f of ["panel.css", "quick-add.html", "settings.html"]) {
      expect(readFileSync(join(DESKTOP, "macos", f), "utf8"), f).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    }
  });

  it("name no secrets file", () => {
    for (const f of sources(DESKTOP)) expect(readFileSync(f, "utf8"), f).not.toMatch(/\.config\/software-factory|["'`/]\.env\b|SECRETS_FILE/);
  });
});
