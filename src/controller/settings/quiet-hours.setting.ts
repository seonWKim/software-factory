// Design 09-notifications: the local-time window in which notices are held, then covered by one summary. Settable at
// runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "quiet_hours",
  owner: "controller",
  type: "string",
  default: "",
  description: "Local window, HH:MM-HH:MM, that holds notices until it ends, then sends one summary; empty is off.",
  applies: "the next notifications pass (each poll)",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
