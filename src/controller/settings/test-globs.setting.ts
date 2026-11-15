// Design 05-restarts (2026-11-15): the paths auto_grant_test_paths counts as test files. Settable at runtime
// (`factory settings set`); fewer globs grant less.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "test_globs",
  owner: "controller",
  type: "list",
  default: ["tests/**", "**/*.test.*"],
  description: "Globs of the test files an implement run's ask may be granted automatically.",
  applies: "the controller's next needs-human stop",
  direction: "tighten-only",
  tighter: "fewer",
  changed_by: "runtime",
  scope: "global",
});
