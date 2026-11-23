// Design 04-pre-push-gates: the gate Stop check's time limit, read live for each agent run the worker starts.
// Settable at runtime (`factory settings set`); STOP_CHECK_MS in src/impl/runner/gate-hooks.ts is the same value as
// the runner's fallback when a spec gives none.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "agent_stop_check_ms",
  owner: "worker",
  type: "integer",
  default: 2400000,
  description: "Longest the gate Stop check (the check list run when an agent tries to finish) may take.",
  applies: "the next run that starts",
  direction: "free",
  changed_by: "runtime",
  scope: "global",
});
