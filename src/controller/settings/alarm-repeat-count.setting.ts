// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "alarm_repeat_count",
  owner: "controller",
  type: "integer",
  default: 3,
  description: "Matching failed runs on distinct items, or zero-token agent runs in a row, that raise an alert.",
  applies: "the next alarm step (each poll)",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
