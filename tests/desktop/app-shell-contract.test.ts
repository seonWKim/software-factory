// The AppShell contract (src/interfaces/app-shell.ts), run against the fake and the macOS shell with Electron mocked.
import { describe, expect, it } from "vitest";
import type { AppShell } from "../../src/interfaces/app-shell.js";
import { createMacosShell } from "../../desktop/electron/macos/app-shell.js";
import { FakeAppShell, electronMock, flush } from "./fakes.js";

interface Harness {
  readonly shell: AppShell;
  /** The URL each window loaded first, one entry per window. */
  windows(): string[];
  windowVisible(): boolean;
  menuText(): string;
  closeWindow(): void;
  exited(): boolean;
  /** Another app takes `accelerator`. */
  take(accelerator: string): void;
  /** The person presses `accelerator`. */
  press(accelerator: string): void;
  shortcuts(): string[];
  /** The notices shown, as title and body. */
  shown(): { title: string; body: string }[];
  /** The person clicks the `n`th notice shown. */
  clickNotice(n: number): void;
  /** Every URL any window loaded, in order. */
  loads(): string[];
}

const harnesses: Record<string, () => Harness> = {
  fake: () => {
    const taken = new Set<string>();
    const shell = new FakeAppShell(true, taken);
    return {
      take: (a) => taken.add(a),
      press: (a) => shell.shortcuts.get(a)?.(),
      shortcuts: () => [...shell.shortcuts.keys()],
      shell,
      windows: () => shell.windows,
      windowVisible: () => shell.visible,
      menuText: () => shell.menuText(),
      closeWindow: () => shell.closeWindow(),
      exited: () => shell.exited,
      shown: () => shell.notices.map(({ title, body }) => ({ title, body })),
      clickNotice: (n) => shell.clickNotice(n),
      loads: () => shell.loads,
    };
  },
  macos: () => {
    const m = electronMock();
    const shell = createMacosShell(m.electron, { preload: "/app/preload.cjs" });
    return {
      take: (a) => m.globalShortcut.taken.add(a),
      press: (a) => m.globalShortcut.press(a),
      shortcuts: () => [...m.globalShortcut.registered.keys()],
      shell,
      windows: () => m.windows.map((w) => w.loads[0]!),
      windowVisible: () => m.windows.some((w) => w.visible && !w.destroyed),
      menuText: () => m.tray.title,
      closeWindow: () => m.windows.at(-1)!.close(),
      exited: m.exited,
      shown: () => m.notifications.filter((n) => n.shown).map((n) => n.options),
      clickNotice: (n) => m.notifications[n]!.click(),
      loads: () => m.windows.flatMap((w) => w.loads),
    };
  },
};

const DASHBOARD = "http://127.0.0.1:4310/app/";

for (const [name, make] of Object.entries(harnesses)) {
  describe(`AppShell contract: ${name}`, () => {
    it("opens one window on the given URL and shows it again on the next openWindow", () => {
      const h = make();
      h.shell.openWindow(DASHBOARD);
      h.closeWindow();
      expect(h.windowVisible()).toBe(false);
      h.shell.openWindow(DASHBOARD);
      expect(h.windows()).toEqual([DASHBOARD]);
      expect(h.windowVisible()).toBe(true);
    });

    it("shows the needs-you count in the menu bar, and a dash while it is unknown", () => {
      const h = make();
      h.shell.setStatus({ state: "running", needsYou: 3 });
      expect(h.menuText()).toContain("3");
      h.shell.setStatus({ state: "not reachable", needsYou: null });
      expect(h.menuText()).toContain("–");
    });

    it("closing the window neither drains nor exits", async () => {
      const h = make();
      let drains = 0;
      h.shell.onQuit(async () => void drains++);
      h.shell.openWindow(DASHBOARD);
      h.closeWindow();
      await flush();
      expect(drains).toBe(0);
      expect(h.exited()).toBe(false);
    });

    it("registers a shortcut that runs its handler, and releases it", () => {
      const h = make();
      let presses = 0;
      expect(h.shell.registerShortcut("Alt+Space", () => void presses++)).toBe(true);
      h.press("Alt+Space");
      expect(presses).toBe(1);
      h.shell.unregisterShortcut("Alt+Space");
      h.press("Alt+Space");
      expect(presses).toBe(1);
      expect(h.shortcuts()).toEqual([]);
      h.shell.unregisterShortcut("Alt+Space");
    });

    it("refuses a shortcut another app holds, registering nothing", () => {
      const h = make();
      h.take("Command+Space");
      expect(h.shell.registerShortcut("Command+Space", () => {})).toBe(false);
      expect(h.shortcuts()).toEqual([]);
    });

    it("notify shows a notice with the title and body", () => {
      const h = make();
      h.shell.openWindow(DASHBOARD);
      h.shell.notify("Software Factory", "A spec waits for you", `${DASHBOARD}items/wi_1`);
      expect(h.shown()).toEqual([{ title: "Software Factory", body: "A spec waits for you" }]);
    });

    it("a click on a notice shows the window and loads its target", () => {
      const h = make();
      h.shell.openWindow(DASHBOARD);
      h.closeWindow();
      h.shell.notify("Software Factory", "A merge waits for you", `${DASHBOARD}items/wi_2`);
      h.clickNotice(0);
      expect(h.windowVisible()).toBe(true);
      expect(h.loads()).toEqual([DASHBOARD, `${DASHBOARD}items/wi_2`]);
    });

    it("a click on a notice whose target is outside the dashboard's /app/ URL loads nothing", () => {
      const h = make();
      h.shell.openWindow(DASHBOARD);
      h.closeWindow();
      for (const target of ["https://example.com/app/", "http://127.0.0.1:4310/api/v1/notices", "http://127.0.0.1:4311/app/", `${DASHBOARD}../api/v1/notices`, "not a url"]) {
        h.shell.notify("Software Factory", "An item needs you", target);
      }
      for (let n = 0; n < 5; n++) h.clickNotice(n);
      expect(h.windowVisible()).toBe(false);
      expect(h.loads()).toEqual([DASHBOARD]);
    });

    it("quit runs the drain once and exits only after it finished", async () => {
      const h = make();
      let drains = 0;
      let finish!: () => void;
      h.shell.onQuit(() => {
        drains += 1;
        return new Promise<void>((r) => (finish = r));
      });
      h.shell.quit();
      h.shell.quit();
      await flush();
      expect(drains).toBe(1);
      expect(h.exited()).toBe(false);
      finish();
      await flush();
      expect(h.exited()).toBe(true);
    });
  });
}
