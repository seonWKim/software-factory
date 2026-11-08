// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "deny_paths",
  owner: "guards",
  type: "list",
  default: null,
  description: "Absolute paths that agent runs may never read.",
  applies: null,
  direction: "tighten-only",
  tighter: "more",
  changed_by: "review",
  scope: "global",
  guard: true,
});
