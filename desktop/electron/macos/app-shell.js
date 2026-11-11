// The macOS AppShell (src/interfaces/app-shell.ts): one dashboard window, a menu bar item, system-wide shortcuts
// (globalShortcut) and a Quit that drains.
// Electron comes in as an argument; only main.js imports it, so tests pass a mock.
import { PRODUCT_NAME } from "../common/product.js";
import { menuTitle } from "../common/status.js";

/** The dashboard window's options: no Node in the page, an isolated and sandboxed renderer. */
export const windowOptions = (preload) => ({
  width: 1280,
  height: 860,
  title: PRODUCT_NAME,
  webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
});

/** The title of the error dialog when the shell cannot start. */
export const STARTUP_ERROR_TITLE = `${PRODUCT_NAME} could not start`;

/** How long the window waits before loading the dashboard again after a failed load (the supervisor is starting). */
export const RELOAD_DELAY_MS = 2_000;

/** `menu`: extra menu bar items, shown above Quit (the quick-add box and its shortcut setting). */
export function createMacosShell(electron, { preload, keepRunningWhenClosed = true, menu = [], timers = globalThis }) {
  const { app, BrowserWindow, Menu, Tray, nativeImage, globalShortcut } = electron;
  let url = null;
  let win = null;
  let drain = async () => {};
  let quitting = false;
  let status = { state: "starting", needsYou: null };
  const tray = new Tray(nativeImage.createEmpty());

  const quit = () => app.quit();

  const show = () => {
    if (url === null) return;
    if (win !== null && !win.isDestroyed()) {
      win.show();
      win.focus();
      return;
    }
    const w = new BrowserWindow(windowOptions(preload));
    const only = url;
    w.webContents.on("will-navigate", (e, target) => {
      if (!target.startsWith(only)) e.preventDefault();
    });
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("did-fail-load", () => timers.setTimeout(() => !w.isDestroyed() && void w.loadURL(only), RELOAD_DELAY_MS));
    w.on("close", (e) => {
      if (quitting) return;
      // Closing the window hides it: the menu bar item and the factory keep running. Off: closing is a Quit.
      e.preventDefault();
      if (keepRunningWhenClosed) w.hide();
      else quit();
    });
    void w.loadURL(only);
    win = w;
  };

  const render = () => {
    tray.setTitle(menuTitle(status));
    tray.setToolTip(`${PRODUCT_NAME}: ${status.state}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Factory: ${status.state}`, enabled: false },
        { label: `Needs you: ${status.needsYou ?? "–"}`, enabled: false },
        { type: "separator" },
        { label: "Open dashboard", click: show },
        ...menu.map(({ label, click }) => ({ label, click })),
        { label: `Quit ${PRODUCT_NAME}`, accelerator: "Command+Q", click: quit },
      ]),
    );
  };

  // Cmd+Q, the app menu's Quit and the menu bar Quit all reach before-quit: hold the exit until the drain is done.
  app.on("before-quit", (e) => {
    e.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.resolve()
      .then(() => drain())
      .finally(() => app.exit(0));
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => {});
  app.on("activate", show);
  render();

  return {
    openWindow(u) {
      url = u;
      show();
    },
    setStatus(s) {
      status = s;
      render();
    },
    onQuit(d) {
      drain = d;
    },
    quit,
    registerShortcut(accelerator, onPress) {
      // register throws on a string that is not an accelerator, and answers false when another app holds it.
      try {
        return globalShortcut.register(accelerator, onPress) === true;
      } catch {
        return false;
      }
    },
    unregisterShortcut(accelerator) {
      try {
        if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
      } catch {
        // Not an accelerator: nothing of ours to release.
      }
    },
  };
}
