// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "max_restart",
  owner: "controller",
  type: "integer",
  default: 3,
  description: "Infra failures of one step (lease loss, timeout, crash) before it blocks on a human.",
  applies: "the controller's next decision",
  direction: "tighten-only",
  tighter: "lower",
  changed_by: "runtime",
  scope: "global",
});
