// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "mode",
  owner: "controller",
  type: "enum",
  default: "manual",
  description: "Manual waits for a person at every spec and merge; auto approves and merges what it may itself.",
  applies: "the controller's next spec approval or merge",
  // free, not tighten-only: a project's mode stands on its own (docs/design/08-settings.md, #444); every change
  // of it needs approve_merge on the project instead.
  direction: "free",
  changed_by: "runtime",
  scope: "project",
  dial: true,
  change_needs: "approve_merge",
});
