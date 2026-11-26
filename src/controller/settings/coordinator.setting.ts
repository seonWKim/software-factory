// Design 05-coordinator: the coordinator's switch, read live at each controller tick, as worker_kinds is read at each
// claim. Settable at runtime (`factory settings set coordinator true`); off stops new cycles, on resumes them.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "coordinator",
  owner: "controller",
  type: "boolean",
  default: false,
  description: "Whether the coordinator runs its cycle every 15 minutes and acts on the work items.",
  applies: "the controller's next tick",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
