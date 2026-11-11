// The shell's app data folder and its config. Only the desktop shell uses this folder; the factory itself gets it
// as SF_HOME in the supervisor's environment and does not read it yet (docs/design/09-desktop-app.md).
import { join } from "node:path";

/** The factory UI port when the shell config names none (the factory's own `ui.port` default). */
export const DEFAULT_UI_PORT = 4310;

/** Every path the shell reads or writes, under `<home>/Library/Application Support/software-factory/`. */
export function appDataPaths(home) {
  const dir = join(home, "Library", "Application Support", "software-factory");
  const state = join(dir, "state");
  return { dir, config: join(dir, "config.json"), state, log: join(state, "supervisor.log"), chromium: join(state, "chromium") };
}

/**
 * Reads config.json from the app data folder; a missing file is written with the defaults so the person can edit
 * it. `checkout` defaults to `defaultCheckout`, the folder the app was built from. Throws on a malformed file.
 */
export function loadShellConfig(paths, fs, defaultCheckout) {
  const defaults = { checkout: defaultCheckout, ui_port: DEFAULT_UI_PORT, keep_running_when_closed: true };
  let raw;
  try {
    raw = fs.readFileSync(paths.config, "utf8");
  } catch (e) {
    if (e?.code !== "ENOENT") throw e;
    fs.mkdirSync(paths.dir, { recursive: true });
    fs.writeFileSync(paths.config, `${JSON.stringify(defaults, null, 2)}\n`);
    return defaults;
  }
  const c = { ...defaults, ...JSON.parse(raw) };
  const problems = [];
  if (typeof c.checkout !== "string" || !c.checkout.startsWith("/")) problems.push("checkout must be an absolute folder");
  if (!Number.isInteger(c.ui_port) || c.ui_port < 1 || c.ui_port > 65535) problems.push("ui_port must be an integer from 1 to 65535");
  if (typeof c.keep_running_when_closed !== "boolean") problems.push("keep_running_when_closed must be true or false");
  if (problems.length > 0) throw new Error(`${paths.config}: ${problems.join("; ")}`);
  return { checkout: c.checkout, ui_port: c.ui_port, keep_running_when_closed: c.keep_running_when_closed };
}
