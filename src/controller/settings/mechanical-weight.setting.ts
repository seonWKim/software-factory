// Settable at runtime (`factory settings set`): design 08-settings, phase 1 of the live file-only keys.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "mechanical_weight",
  owner: "controller",
  type: "integer",
  default: 0.25,
  description: "Weight of a shared mechanical path (index and History lines), above 0 and below 1.0.",
  applies: "the next claim",
  direction: "tighten-only",
  tighter: "higher",
  changed_by: "runtime",
  scope: "global",
});
