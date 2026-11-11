// Wires one desktop shell: reads its config from the app data folder, starts the supervisor from the chosen
// checkout, opens the dashboard, keeps the menu bar status fresh and drains the supervisor on Quit. Every effect
// comes in as an argument, so a test runs it with fakes. The shell reads only its app data folder: never the
// checkout's files and never a secrets file.
import { appDataPaths, loadShellConfig } from "./app-data.js";
import { DRAIN_TIMEOUT_MS } from "./quit-drain.js";
import { dashboardUrl, overviewUrl, pollStatus } from "./status.js";
import { startSupervisor, supervisorCommand } from "./supervisor.js";

export function runShell({ home, fs, spawn, execPath, env, fetch, defaultCheckout, makeShell, timers = globalThis }) {
  const paths = appDataPaths(home);
  const config = loadShellConfig(paths, fs, defaultCheckout);
  const shell = makeShell(config);
  fs.mkdirSync(paths.state, { recursive: true });
  const log = fs.openSync(paths.log, "a");
  const { command, args, options } = supervisorCommand({ execPath, checkout: config.checkout, env, sfHome: paths.dir });
  const supervisor = startSupervisor({
    spawn,
    command,
    args,
    options: { ...options, stdio: ["ignore", log, log] },
    timers,
    onExit: (code, signal) => fs.appendFileSync(paths.log, `[shell] supervisor exited (code ${code}, signal ${signal})\n`),
  });
  shell.openWindow(dashboardUrl(config.ui_port));
  const stopStatus = pollStatus({ fetch, url: overviewUrl(config.ui_port), onStatus: (s) => shell.setStatus(s), timers });
  shell.onQuit(async () => {
    stopStatus();
    await supervisor.stop(DRAIN_TIMEOUT_MS);
    fs.closeSync(log);
  });
  return { paths, config, shell, supervisor };
}
