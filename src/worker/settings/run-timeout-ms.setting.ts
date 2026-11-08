// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "run_timeout_ms",
  owner: "worker",
  type: "integer",
  default: 2700000,
  description: "Longest an agent run may take before it is stopped.",
  applies: "the next run that starts",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
