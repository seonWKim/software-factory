// Design 05-restarts (2026-11-15): an implement run that asks only for test paths gets them once without the owner.
// Settable at runtime (`factory settings set`), per project; a project may only turn it off.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "auto_grant_test_paths",
  owner: "controller",
  type: "boolean",
  default: true,
  description: "Whether an implement run that asks only for test paths gets them once, without the owner.",
  applies: "the controller's next needs-human stop",
  direction: "tighten-only",
  tighter: [false, true],
  changed_by: "runtime",
  scope: "project",
});
