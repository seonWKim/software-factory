// Settable at runtime (`factory settings set`): design 08-settings, phase 1 of the live file-only keys.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "stall_ms",
  owner: "worker",
  type: "integer",
  default: 300000,
  description: "Longest an agent run may go with no model output and no open tool call before it counts as stalled.",
  applies: "the next run that starts",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
