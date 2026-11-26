// Permission modes, phase 1 (design 08-permissions, 2026-11-27). Settable at runtime by the owner only (OWNER_KEYS);
// a set toward `full` loosens it and needs approve_merge on the project. Nothing reads it yet: the gate is a later phase.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "permission_mode",
  owner: "controller",
  type: "enum",
  default: "ask_irreversible",
  description: "What a write asks the owner first: every write, only irreversible ones, or none (full).",
  applies: "the next command the permission gate checks",
  direction: "tighten-only",
  tighter: ["ask_all", "ask_irreversible", "full"],
  changed_by: "runtime",
  scope: "global",
});
