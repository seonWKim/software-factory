// The shell's native settings view: one small window to change the quick-add shortcut. Save registers the new
// shortcut before the old one is released (quickAddShortcut.change): a refused one is shown here and the old stays.
import { panelPreferences, panelWindow, showFocused } from "./panel.js";

/** The channels between the settings page (panel-preload.cjs) and this module. */
export const SETTINGS = { get: "settings:get", set: "settings:set" };

export const settingsOptions = (preload) => ({
  width: 460,
  height: 220,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  title: "Quick-add shortcut",
  webPreferences: panelPreferences(preload),
});

export function createSettingsView({ BrowserWindow, ipcMain }, { pageUrl, preload, shortcut }) {
  let win = null;
  const fromView = (e) => win !== null && !win.isDestroyed() && e.sender === win.webContents;
  ipcMain.handle(SETTINGS.get, (e) => (fromView(e) ? { shortcut: shortcut.current() } : null));
  ipcMain.handle(SETTINGS.set, (e, accelerator) => (fromView(e) ? shortcut.change(accelerator) : null));
  return {
    open() {
      if (win === null || win.isDestroyed()) win = panelWindow(BrowserWindow, settingsOptions(preload), pageUrl);
      showFocused(win);
    },
  };
}
