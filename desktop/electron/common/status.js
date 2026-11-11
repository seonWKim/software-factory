// The menu bar status: the factory's state and its needs-you count, read from the dashboard's existing overview
// route every 15 seconds. No new route and no store read: the shell only asks the local API.

/** How often the shell reads /api/v1/overview. */
export const STATUS_INTERVAL_MS = 15_000;

/** The dashboard window's only URL. */
export const dashboardUrl = (port) => `http://127.0.0.1:${port}/app/`;

/** The overview route the status count comes from. */
export const overviewUrl = (port) => `http://127.0.0.1:${port}/api/v1/overview`;

/** The status in an overview body: `factory.state` (null: the supervisor is stopped) and `needs_you`. */
export function statusFromOverview(body) {
  const factory = body?.factory;
  const state = factory === null ? "stopped" : typeof factory?.state === "string" ? factory.state : "running";
  return { state, needsYou: Number.isInteger(body?.needs_you) ? body.needs_you : null };
}

/** The status while the dashboard does not answer (the supervisor is starting or restarting). */
export const UNREACHABLE = { state: "not reachable", needsYou: null };

/** The menu bar text: the count, or a dash while it is unknown. */
export const menuTitle = (status) => `SF ${status.needsYou ?? "–"}`;

/** Reads the overview now and every `intervalMs`, and hands each status to `onStatus`. Returns a stop function. */
export function pollStatus({ fetch, url, onStatus, intervalMs = STATUS_INTERVAL_MS, timers = globalThis }) {
  let stopped = false;
  const read = async () => {
    let status;
    try {
      const res = await fetch(url);
      status = res.ok ? statusFromOverview(await res.json()) : UNREACHABLE;
    } catch {
      status = UNREACHABLE;
    }
    if (!stopped) onStatus(status);
  };
  void read();
  const timer = timers.setInterval(() => void read(), intervalMs);
  return () => {
    stopped = true;
    timers.clearInterval(timer);
  };
}
