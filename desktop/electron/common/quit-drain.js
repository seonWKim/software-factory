// Quit drains the factory: SIGTERM asks the supervisor to stop its children and exit; a supervisor still running
// after the drain timeout is killed (docs/design/09-desktop-app.md, decision 3).

/** How long Quit waits for the supervisor to exit after SIGTERM before it sends SIGKILL. */
export const DRAIN_TIMEOUT_MS = 60_000;

/**
 * Sends SIGTERM through `kill`, then waits for `exited`. After `timeoutMs` without an exit it sends SIGKILL and
 * waits again. Resolves "drained" or "killed".
 */
export async function drainChild({ kill, exited }, { timeoutMs = DRAIN_TIMEOUT_MS, timers = globalThis } = {}) {
  kill("SIGTERM");
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = timers.setTimeout(() => resolve(true), timeoutMs);
  });
  const late = await Promise.race([exited.then(() => false), timedOut]);
  timers.clearTimeout(timer);
  if (!late) return "drained";
  kill("SIGKILL");
  await exited;
  return "killed";
}
