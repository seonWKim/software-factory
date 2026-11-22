// Design 09-status-page: the local time before which non-urgent Needs-you asks are held (not counted, read "Held
// until <review_time>"). Settable at runtime (`factory settings set`, POST /api/v1/settings).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "review_time",
  owner: "controller",
  type: "string",
  default: "09:00",
  description: "Local time, HH:MM, until which asks that are no merge and block nothing are held; empty is off.",
  applies: "the next load of the Tasks page",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
