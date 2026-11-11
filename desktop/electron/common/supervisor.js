// The factory's supervisor (`dist/main.js dev` in the chosen checkout) as the shell's child process. It is started
// again after it exits, until stop() drains it for Quit.
import { join } from "node:path";
import { drainChild } from "./quit-drain.js";

/** How long the shell waits after the supervisor exits before it starts it again. */
export const RESTART_DELAY_MS = 5_000;

/**
 * The command that runs the supervisor of `checkout` with the shell's own runtime as Node (ELECTRON_RUN_AS_NODE).
 * `SF_HOME` is the shell's app data folder; the factory does not read it yet.
 */
export function supervisorCommand({ execPath, checkout, env, sfHome }) {
  return {
    command: execPath,
    args: ["--disable-warning=ExperimentalWarning", join(checkout, "dist", "main.js"), "dev"],
    options: { cwd: checkout, env: { ...env, ELECTRON_RUN_AS_NODE: "1", SF_HOME: sfHome } },
  };
}

/**
 * Starts `command` through `spawn` and starts it again `restartDelayMs` after each exit. `onExit(code, signal)`
 * hears every exit. stop(timeoutMs) cancels the restart and drains the running child (quit-drain.js).
 */
export function startSupervisor({ spawn, command, args, options, restartDelayMs = RESTART_DELAY_MS, timers = globalThis, onExit = () => {} }) {
  let running = null;
  let restart = null;
  let stopping = false;

  const start = () => {
    restart = null;
    const child = spawn(command, args, options);
    let ended;
    const exited = new Promise((resolve) => {
      ended = resolve;
    });
    let done = false;
    const end = (code, signal) => {
      if (done) return;
      done = true;
      running = null;
      ended();
      onExit(code, signal);
      if (!stopping) restart = timers.setTimeout(start, restartDelayMs);
    };
    child.once("exit", end);
    // A child that could not start (a missing runtime, a bad cwd) emits "error" and no "exit".
    child.once("error", () => end(null, null));
    running = { kill: (signal) => child.kill(signal), exited };
  };

  start();
  return {
    stop(timeoutMs) {
      stopping = true;
      if (restart !== null) timers.clearTimeout(restart);
      restart = null;
      return running === null ? Promise.resolve("not-running") : drainChild(running, { timeoutMs, timers });
    },
  };
}
