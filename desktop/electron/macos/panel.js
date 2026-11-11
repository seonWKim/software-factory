// The shell's small windows (the quick-add box and the shortcut settings view): a static page from this folder, an
// isolated and sandboxed renderer with the panel preload, no navigation and no new windows.

/** The panels' webPreferences: the dashboard window's, with the panel preload. */
export const panelPreferences = (preload) => ({ contextIsolation: true, nodeIntegration: false, sandbox: true, preload });

/** Makes a panel window with `options` on `pageUrl` and locks it to that page. */
export function panelWindow(BrowserWindow, options, pageUrl) {
  const w = new BrowserWindow(options);
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  void w.loadURL(pageUrl);
  return w;
}

/** Shows `w` and gives it the keyboard. */
export function showFocused(w) {
  w.show();
  w.focus();
}
