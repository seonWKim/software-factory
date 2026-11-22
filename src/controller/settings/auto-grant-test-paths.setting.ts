// Design 05-restarts (2026-11-15): an implement run that asks only for test paths gets them once without the owner;
// since 2026-11-19 a few ordinary files too (src/core/auto-grant.ts fewOrdinaryPaths). The key keeps its name.
// Settable at runtime (`factory settings set`), per project; a project may only turn it off.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "auto_grant_test_paths",
  owner: "controller",
  type: "boolean",
  default: true,
  description: "Whether an implement run asking for test paths, or up to 3 other unprotected files, gets them once.",
  applies: "the controller's next needs-human stop",
  direction: "tighten-only",
  tighter: [false, true],
  changed_by: "runtime",
  scope: "project",
});
