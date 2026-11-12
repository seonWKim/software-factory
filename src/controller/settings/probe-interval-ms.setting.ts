// Settable at runtime (`factory settings set`): design 08-settings, phase 1 of the live file-only keys.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "probe_interval_ms",
  owner: "controller",
  type: "integer",
  default: 600000,
  description: "How often a stall pause probes the cheap model; a failed probe moves the pause this much later.",
  applies: "the next stall pause or probe",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
