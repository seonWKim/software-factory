// The macOS app's entry: the only file that imports electron. It wires the real Electron, fs, spawn and fetch
// into runShell (../common/run-shell.js) and the macOS AppShell (./app-shell.js).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";
import pkg from "../../package.json" with { type: "json" };
import { appDataPaths } from "../common/app-data.js";
import { runShell } from "../common/run-shell.js";
import { dashboardUrl } from "../common/status.js";
import { createMacosShell } from "./app-shell.js";

const { app, dialog } = electron;
const here = dirname(fileURLToPath(import.meta.url));
const home = homedir();

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
      const { shell, config } = await runShell({
        home,
        fs,
        spawn,
        execPath: process.execPath,
        env: process.env,
        fetch: globalThis.fetch,
        // The build writes the folder it ran in; run from the repository, the checkout is the repository itself.
        defaultCheckout: pkg.softwareFactory?.checkout ?? resolve(here, "..", "..", ".."),
        makeShell: (c) => createMacosShell(electron, { preload: join(here, "preload.cjs"), keepRunningWhenClosed: c.keep_running_when_closed }),
      });
      app.on("second-instance", () => shell.openWindow(dashboardUrl(config.ui_port)));
    } catch (e) {
      dialog.showErrorBox("Software Factory could not start", e instanceof Error ? e.message : String(e));
      app.exit(1);
    }
  });
}
