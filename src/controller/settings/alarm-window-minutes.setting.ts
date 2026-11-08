// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "alarm_window_minutes",
  owner: "controller",
  type: "integer",
  default: 60,
  description: "Minutes over which the alarm counts matching failed runs and zero-token runs.",
  applies: "the next alarm step (each poll)",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
