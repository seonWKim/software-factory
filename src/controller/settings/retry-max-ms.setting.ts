// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "retry_max_ms",
  owner: "controller",
  type: "integer",
  default: 1800000,
  description: "Longest wait between retries, and the pause after a rate limit with no reset time.",
  applies: "the controller's next decision",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
