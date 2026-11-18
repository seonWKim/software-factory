// Settable at runtime (`factory settings set`): design 07-self-improvement, conflict hotspots.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "conflict_hotspot_threshold",
  owner: "controller",
  type: "integer",
  default: 3,
  description: "Conflicts or held items on one file in 7 days that file a task to reduce conflicts on it.",
  applies: "the next improve run",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
