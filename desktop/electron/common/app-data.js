// The shell's app data folder and its config. Only the desktop shell uses this folder; the factory itself gets it
// as SF_HOME in the supervisor's environment and does not read it yet (docs/design/09-desktop-app.md).
import { join } from "node:path";

/** The factory UI port when the shell config names none (the factory's own `ui.port` default). */
export const DEFAULT_UI_PORT = 4310;

/** The quick-add box's shortcut when the shell config names none (`app.quick_add_shortcut`). */
export const DEFAULT_QUICK_ADD_SHORTCUT = "Alt+Space";

/** Every path the shell reads or writes, under `<home>/Library/Application Support/software-factory/`. */
export function appDataPaths(home) {
  const dir = join(home, "Library", "Application Support", "software-factory");
  const state = join(dir, "state");
  return {
    dir,
    config: join(dir, "config.json"),
    state,
    log: join(state, "supervisor.log"),
    chromium: join(state, "chromium"),
    // The owner notices this shell has shown (notices.js).
    notices: join(state, "notices-shown.json"),
  };
}

/**
 * Reads config.json from the app data folder; a missing file is written with the defaults so the person can edit
 * it. `checkout` defaults to `defaultCheckout`, the folder the app was built from. Throws on a malformed file.
 */
export function loadShellConfig(paths, fs, defaultCheckout) {
  const defaults = { checkout: defaultCheckout, ui_port: DEFAULT_UI_PORT, keep_running_when_closed: true, app: { quick_add_shortcut: DEFAULT_QUICK_ADD_SHORTCUT } };
  let raw;
  try {
    raw = fs.readFileSync(paths.config, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.config, `${JSON.stringify(defaults, null, 2)}\n`);
    return defaults;
  }
  const read = JSON.parse(raw);
  // A config written before the quick-add box has no `app` block: its shortcut takes the default.
  const c = { ...defaults, ...read, app: { ...defaults.app, ...read.app } };
  const problems = [];
  if (typeof c.checkout !== "string" || !c.checkout.startsWith("/")) problems.push("checkout must be an absolute folder");
  if (!Number.isInteger(c.ui_port) || c.ui_port < 1 || c.ui_port > 65535) problems.push("ui_port must be an integer from 1 to 65535");
  if (typeof c.keep_running_when_closed !== "boolean") problems.push("keep_running_when_closed must be true or false");
  if (typeof c.app.quick_add_shortcut !== "string" || c.app.quick_add_shortcut.trim() === "") problems.push("app.quick_add_shortcut must be a shortcut such as Alt+Space");
  if (problems.length > 0) throw new Error(`${paths.config}: ${problems.join("; ")}`);
  return { checkout: c.checkout, ui_port: c.ui_port, keep_running_when_closed: c.keep_running_when_closed, app: { quick_add_shortcut: c.app.quick_add_shortcut } };
}

/** Writes `accelerator` as `app.quick_add_shortcut` into config.json, keeping every other key the person set. */
export function saveQuickAddShortcut(paths, fs, accelerator) {
  const c = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  c.app = { ...c.app, quick_add_shortcut: accelerator };
  fs.writeFileSync(paths.config, `${JSON.stringify(c, null, 2)}\n`);
}
