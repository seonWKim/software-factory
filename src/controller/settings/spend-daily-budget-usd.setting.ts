// Design 06-spend: the daily spend budget in dollars. Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting<number>({
  key: "spend.daily_budget_usd",
  owner: "controller",
  type: "usd",
  default: null,
  description: "Dollars per UTC day; spend at 80% and 100% of it alerts once each in Needs you. None: no budget.",
  applies: "the next alarm step (each poll)",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
