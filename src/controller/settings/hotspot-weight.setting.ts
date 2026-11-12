// Settable at runtime (`factory settings set`): design 08-settings, phase 1 of the live file-only keys.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "hotspot_weight",
  owner: "controller",
  type: "integer",
  default: 3,
  description: "Weight of a shared hotspot path in the coordination cost of two runs side by side.",
  applies: "the next claim",
  direction: "tighten-only",
  tighter: "higher",
  changed_by: "runtime",
  scope: "global",
});
