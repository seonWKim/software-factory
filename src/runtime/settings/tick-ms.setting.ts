// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "tick_ms",
  owner: "runtime",
  type: "integer",
  default: 2000,
  description: "How often the controller and the worker pool run their loop.",
  applies: "the next tick",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
