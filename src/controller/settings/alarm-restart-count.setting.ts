// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "alarm_restart_count",
  owner: "controller",
  type: "integer",
  default: 5,
  description: "Child restarts within 30 minutes that raise an alert.",
  applies: "the next alarm step (each poll)",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
