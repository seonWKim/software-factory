// Settable at runtime (`factory settings set`): design 08-settings, phase 1 of the live file-only keys.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "max_coordination_cost",
  owner: "controller",
  type: "integer",
  default: 2.5,
  description: "Coordination cost at or above which an implement run waits for the work it shares files with.",
  applies: "the next claim",
  direction: "tighten-only",
  tighter: "lower",
  changed_by: "runtime",
  scope: "global",
});
