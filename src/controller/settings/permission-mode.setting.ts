// Permission modes, phase 1 (design 08-permissions, 2026-11-27). Settable at runtime by the owner only (OWNER_KEYS);
// a set toward `full` loosens it and needs approve_merge on the project. Nothing reads it yet: the gate is a later phase.

import { defineSetting } from "../../shared/setting.js";

/** The values, tightest first: ask before every write, before irreversible ones only, or never. */
export const PERMISSION_MODES = ["ask_all", "ask_irreversible", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export default defineSetting<PermissionMode>({
  key: "permission_mode",
  owner: "controller",
  type: "enum",
  default: "ask_irreversible",
  description: "What a write asks the owner first: every write, only irreversible ones, or none (full).",
  applies: "the next command the permission gate checks",
  direction: "tighten-only",
  tighter: PERMISSION_MODES,
  changed_by: "runtime",
  scope: "global",
});
