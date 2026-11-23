// Design 05-interactive-sessions (2026-11-21): the run kinds a worker claims, read live at each claim. Settable at
// runtime (`factory settings set`); left out of the list, implement and resolve runs wait for an interactive session.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "worker_kinds",
  owner: "worker",
  type: "list",
  // WORKER_KINDS in src/core/settings.ts, written out so this file adds no legacy import; tests/settings-catalog.test.ts holds the two equal.
  default: ["triage", "review", "merge-check", "update", "restart", "improve", "implement", "resolve", "judge"],
  description: "Run kinds the workers claim; a queued run of another kind waits for an interactive session.",
  applies: "the worker's next claim",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
