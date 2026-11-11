// Wires one desktop shell: reads its config from the app data folder, starts the supervisor from the chosen
// checkout (or attaches to one already running there), opens the dashboard, keeps the menu bar status fresh,
// registers the quick-add shortcut and drains the supervisor it started on Quit. Every effect comes in as an argument, so a test runs it with fakes.
// The shell writes only its app data folder; of the checkout it reads only the supervisor's status file
// (attach.js), and it never reads a secrets file.
import { appDataPaths, loadShellConfig, saveQuickAddShortcut } from "./app-data.js";
import { liveSupervisor, pidAlive } from "./attach.js";
import { DRAIN_TIMEOUT_MS } from "./quit-drain.js";
import { dashboardUrl, overviewUrl, pollStatus } from "./status.js";
import { quickAddShortcut } from "./shortcut.js";
import { startSupervisor, supervisorCommand } from "./supervisor.js";

/** The supervisor of an attached shell: it belongs to someone else, so Quit leaves it running. */
const NOT_OURS = { stop: async () => "not-running" };

export async function runShell({
  home, fs, spawn, execPath, env, fetch, defaultCheckout, makeShell, openQuickAdd = () => {}, notify = () => {}, alive = pidAlive, timers = globalThis,
}) {
  const paths = appDataPaths(home);
  const config = loadShellConfig(paths, fs, defaultCheckout);
  const shell = makeShell(config);
  fs.mkdirSync(paths.state, { recursive: true });
  // A refused shortcut is told and logged; the shell starts all the same.
  const shortcut = quickAddShortcut({
    shell,
    accelerator: config.app.quick_add_shortcut,
    onPress: openQuickAdd,
    notify: (message) => {
      fs.appendFileSync(paths.log, `[shell] ${message}\n`);
      notify(message);
    },
    save: (accelerator) => saveQuickAddShortcut(paths, fs, accelerator),
  });
  const overview = overviewUrl(config.ui_port);
  const attachedTo = await liveSupervisor({ fs, fetch, checkout: config.checkout, overviewUrl: overview, alive });
  let supervisor = NOT_OURS;
  let log = null;
  if (attachedTo !== null) {
    fs.appendFileSync(paths.log, `[shell] attached, not starting a supervisor: ${attachedTo}\n`);
  } else {
    log = fs.openSync(paths.log, "a");
    const { command, args, options } = supervisorCommand({ execPath, checkout: config.checkout, env, sfHome: paths.dir });
    supervisor = startSupervisor({
      spawn,
      command,
      args,
      options: { ...options, stdio: ["ignore", log, log] },
      timers,
      onExit: (code, signal) => fs.appendFileSync(paths.log, `[shell] supervisor exited (code ${code}, signal ${signal})\n`),
    });
  }
  shell.openWindow(dashboardUrl(config.ui_port));
  const stopStatus = pollStatus({ fetch, url: overview, onStatus: (s) => shell.setStatus(s), timers });
  shell.onQuit(async () => {
    stopStatus();
    await supervisor.stop(DRAIN_TIMEOUT_MS);
    if (log !== null) fs.closeSync(log);
  });
  return { paths, config, shell, supervisor, shortcut, attached: attachedTo !== null };
}
