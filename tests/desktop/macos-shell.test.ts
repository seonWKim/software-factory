// The macOS shell with Electron mocked: the window's options and its one URL, close vs Quit, the menu bar.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMacosShell, windowOptions } from "../../desktop/electron/macos/app-shell.js";
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
    const quit = m.menuItem("Quit Software Factory");
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
    expect(m.tray.title).toBe("SF 4");
    expect(m.tray.menu.map((i) => i.label)).toContain("Factory: running");
    expect(m.tray.menu.map((i) => i.label)).toContain("Needs you: 4");
  });
});

describe("desktop/electron sources", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(join(dir, e.name)) : /\.c?js$/.test(e.name) ? [join(dir, e.name)] : [],
    );

  it("only macos/main.js imports electron", () => {
    const importers = sources(DESKTOP)
      .filter((f) => /from\s+["']electron["']|require\(\s*["']electron["']\s*\)/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(DESKTOP.length + 1));
    expect(importers).toEqual(["macos/main.js"]);
  });

  it("name no secrets file", () => {
    for (const f of sources(DESKTOP)) expect(readFileSync(f, "utf8"), f).not.toMatch(/\.config\/software-factory|["'`/]\.env\b|SECRETS_FILE/);
  });
});
