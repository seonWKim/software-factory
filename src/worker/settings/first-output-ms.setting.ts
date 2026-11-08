// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "first_output_ms",
  owner: "worker",
  type: "integer",
  default: 180000,
  description: "Longest an agent run may go from its start with no model output before it counts as stalled.",
  applies: "the next run that starts",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
