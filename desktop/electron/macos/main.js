// The macOS app's entry: the only main-process file that imports electron. It wires the real Electron, fs, spawn
// and fetch into runShell (../common/run-shell.js), the macOS AppShell (./app-shell.js), the quick-add box
// (./quick-add.js) and its shortcut settings view (./settings-view.js).
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import electron from "electron";
import pkg from "../../package.json" with { type: "json" };
import { appDataPaths, saveQuickAddShortcut } from "../common/app-data.js";
import { runShell } from "../common/run-shell.js";
import { dashboardUrl } from "../common/status.js";
import { taskPoster } from "./tasks-client.js";
import { STARTUP_ERROR_TITLE, createMacosShell } from "./app-shell.js";
import { createQuickAdd } from "./quick-add.js";
import { createSettingsView } from "./settings-view.js";
import { quickAddShortcut } from "./shortcut.js";

const { app, dialog } = electron;
const here = dirname(fileURLToPath(import.meta.url));
const home = homedir();
const page = (name) => pathToFileURL(join(here, name)).href;
const panelPreload = join(here, "panel-preload.cjs");

/**
 * The #606 quick-add parser from the checkout's build (dist/core/quick-add.js, pure, no imports), for the box's
 * chips only; the route parses what is stored. Null when dist/ is not built: the box then shows no chips.
 */
async function loadParser(checkout) {
  try {
    const m = await import(pathToFileURL(join(checkout, "dist", "core", "quick-add.js")).href);
    return typeof m.parseQuickAdd === "function" ? m.parseQuickAdd : null;
  } catch {
    return null;
  }
}

// Chromium's own data goes inside the shell's state folder, not in a second Application Support folder.
app.setPath("userData", appDataPaths(home).chromium);

if (!app.requestSingleInstanceLock()) {
  // A second copy would start a second supervisor on the same checkout.
  app.exit(0);
} else {
  // Never a top-level await before "ready": Electron emits it only once the ESM entry has finished loading, so
  // `await app.whenReady()` here waits forever and the app hangs with no window.
  void app.whenReady().then(async () => {
    try {
      let quickAdd = null;
      let settingsView = null;
      const { shell, config, paths } = await runShell({
        home,
        fs,
        spawn,
        execPath: process.execPath,
        env: process.env,
        fetch: globalThis.fetch,
        // The build writes the folder it ran in; run from the repository, the checkout is the repository itself.
        defaultCheckout: pkg.softwareFactory?.checkout ?? resolve(here, "..", "..", ".."),
        makeShell: (c) =>
          createMacosShell(electron, {
            preload: join(here, "preload.cjs"),
            keepRunningWhenClosed: c.keep_running_when_closed,
            menu: [
              { label: "Quick add…", click: () => quickAdd?.open() },
              { label: "Quick-add shortcut…", click: () => settingsView?.open() },
            ],
          }),
      });
      // A refused shortcut is told and logged; the shell runs on with none held.
      const shortcut = quickAddShortcut({
        shell,
        accelerator: config.app.quick_add_shortcut,
        onPress: () => quickAdd?.open(),
        notify: (message) => {
          fs.appendFileSync(paths.log, `[shell] ${message}\n`);
          void dialog.showMessageBox({ type: "warning", message: "Quick-add shortcut", detail: message });
        },
        save: (accelerator) => saveQuickAddShortcut(paths, fs, accelerator),
      });
      quickAdd = createQuickAdd(electron, {
        pageUrl: page("quick-add.html"),
        preload: panelPreload,
        post: taskPoster({ fetch: globalThis.fetch, port: config.ui_port }),
        parse: await loadParser(config.checkout),
        newId: () => `tk_${randomBytes(12).toString("base64url")}`,
      });
      quickAdd.prepare();
      settingsView = createSettingsView(electron, { pageUrl: page("settings.html"), preload: panelPreload, shortcut });
      app.on("second-instance", () => shell.openWindow(dashboardUrl(config.ui_port)));
    } catch (e) {
      dialog.showErrorBox(STARTUP_ERROR_TITLE, e instanceof Error ? e.message : String(e));
      app.exit(1);
    }
  });
}
