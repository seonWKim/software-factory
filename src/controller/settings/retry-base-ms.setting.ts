// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "retry_base_ms",
  owner: "controller",
  type: "integer",
  default: 60000,
  description: "Wait before the first automatic retry; each next retry waits twice as long.",
  applies: "the controller's next decision",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
