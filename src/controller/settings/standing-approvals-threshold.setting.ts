// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "standing_approvals.threshold",
  owner: "controller",
  type: "integer",
  default: 10,
  description: "Spec approvals in a row, with the spec unchanged, before a standing rule is proposed.",
  applies: "the controller's next spec approval",
  direction: "tighten-only",
  tighter: "higher",
  changed_by: "runtime",
  scope: "global",
});
