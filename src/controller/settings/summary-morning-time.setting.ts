// Design 08-schedules-actions: the local time, in the machine's zone, of the owner's morning summary (the summary
// schedule action reads it on each run, so a change moves the next post). Settable at runtime (`factory settings set`,
// POST /api/v1/settings).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "summary_morning_time",
  owner: "controller",
  type: "string",
  default: "08:30",
  description: "Local time, HH:MM in the machine's zone, of the owner's morning summary post.",
  applies: "the next run of a summary schedule",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
