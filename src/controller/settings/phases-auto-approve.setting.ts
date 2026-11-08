// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "phases_auto_approve",
  owner: "controller",
  type: "boolean",
  default: false,
  description: "Whether a phase spec of an approved split needs no approval of its own.",
  applies: "the next phase spec triage writes",
  direction: "tighten-only",
  tighter: [false, true],
  changed_by: "runtime",
  scope: "global",
});
