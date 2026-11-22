// The owner's last look at Needs you, kept in this browser only (local storage); never sent to the server.

const KEY = "factory.needs-you.last-look";
const DAY_MS = 24 * 60 * 60 * 1000;

/** The merges window of a first visit: the last 7 days. */
export const FIRST_LOOK_DAYS = 7;

/** The instant (ms) the owner last looked; on a first visit (nothing stored, or unreadable) `now` minus 7 days. */
export function lastLook(now: number): number {
  try {
    const stored = Number(window.localStorage.getItem(KEY));
    if (Number.isFinite(stored) && stored > 0) return stored;
  } catch {
    // Storage off (private mode): behave as a first visit every time.
  }
  return now - FIRST_LOOK_DAYS * DAY_MS;
}

/** Stores `now` as the last look. */
export function markLook(now: number): void {
  try {
    window.localStorage.setItem(KEY, String(now));
  } catch {
    // Nothing to keep it in: the next visit counts the last 7 days.
  }
}
