// The real Timer (hook budgets): the one place outside the tick loop allowed to set a timer (no-clock test).

import type { Timer } from "../../../hook.js";

export const systemTimer: Timer = {
  after(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      function done(): void {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      }
    });
  },
};
