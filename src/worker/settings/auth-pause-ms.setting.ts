// Settable at runtime (`factory settings set`): design 08-settings, phase 1 of the live file-only keys.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "auth_pause_ms",
  owner: "worker",
  type: "integer",
  default: 1800000,
  description: "How long a forge 401 or 403 pauses implement-type claims; with no value, it follows retry_max_ms.",
  applies: "the next forge auth pause",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
