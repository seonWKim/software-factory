// Ported from src/core/settings.ts (RFC 0015 M10). Settable at runtime (`factory settings set`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "max_diff_files",
  owner: "worker",
  type: "integer",
  default: 40,
  description: "Most changed files a branch diff may have before push.",
  applies: "the next run that starts",
  direction: "tighten-only",
  tighter: "lower",
  changed_by: "runtime",
  scope: "project",
});
