// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "auto_merge_max_tier",
  owner: "controller",
  type: "integer",
  default: 0,
  description: "In auto mode, the highest tier (0 to 3) a reviewed local change merges at by itself; 0 is none.",
  applies: "the controller's next merge",
  direction: "tighten-only",
  tighter: "lower",
  changed_by: "runtime",
  scope: "global",
  dial: true,
  change_needs: "approve_merge",
});
