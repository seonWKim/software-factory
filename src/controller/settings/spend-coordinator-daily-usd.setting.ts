// Design 06-spend: the coordinator's daily spend limit in dollars. Settable at runtime (`factory settings set`).
// Declared ahead of its reader: no cycle reads it yet (a later phase pauses the coordinator when it is reached).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting<number>({
  key: "spend.coordinator_daily_usd",
  owner: "controller",
  type: "usd",
  default: 5,
  description: "Dollars per UTC day the coordinator's cycles may spend on model calls.",
  applies: "the next tick",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
